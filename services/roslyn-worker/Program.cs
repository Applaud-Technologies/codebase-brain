using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.MSBuild;

// Register MSBuild
MSBuildLocator.RegisterDefaults();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSingleton<RoslynAnalyzer>();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));

// Analyze a solution/project
app.MapPost("/analyze", async (AnalyzeRequest request, RoslynAnalyzer analyzer) =>
{
    var result = await analyzer.AnalyzeSolutionAsync(request.SolutionPath);
    return Results.Ok(result);
});

// Find symbol by name
app.MapPost("/find-symbol", async (FindSymbolRequest request, RoslynAnalyzer analyzer) =>
{
    var result = await analyzer.FindSymbolAsync(request.SolutionPath, request.SymbolName);
    return Results.Ok(result);
});

// Find references to a symbol
app.MapPost("/find-references", async (FindReferencesRequest request, RoslynAnalyzer analyzer) =>
{
    var result = await analyzer.FindReferencesAsync(
        request.SolutionPath,
        request.FilePath,
        request.Line,
        request.Column
    );
    return Results.Ok(result);
});

// Find implementations of an interface
app.MapPost("/find-implementations", async (FindImplementationsRequest request, RoslynAnalyzer analyzer) =>
{
    var result = await analyzer.FindImplementationsAsync(
        request.SolutionPath,
        request.InterfaceName
    );
    return Results.Ok(result);
});

// Get call hierarchy
app.MapPost("/call-hierarchy", async (CallHierarchyRequest request, RoslynAnalyzer analyzer) =>
{
    var result = await analyzer.GetCallHierarchyAsync(
        request.SolutionPath,
        request.FilePath,
        request.Line,
        request.Column,
        request.Direction
    );
    return Results.Ok(result);
});

app.Run();

// Request/Response records
record AnalyzeRequest(string SolutionPath);
record FindSymbolRequest(string SolutionPath, string SymbolName);
record FindReferencesRequest(string SolutionPath, string FilePath, int Line, int Column);
record FindImplementationsRequest(string SolutionPath, string InterfaceName);
record CallHierarchyRequest(string SolutionPath, string FilePath, int Line, int Column, string Direction);

record SymbolInfo(
    string Name,
    string QualifiedName,
    string Kind,
    string FilePath,
    int LineStart,
    int LineEnd,
    string? Signature,
    string? Namespace,
    string[]? Modifiers,
    string? ReturnType
);

record AnalysisResult(
    int TotalSymbols,
    int Classes,
    int Interfaces,
    int Methods,
    List<SymbolInfo> Symbols
);

record ReferenceInfo(
    string FilePath,
    int Line,
    int Column,
    string Context
);

record CallInfo(
    string SymbolName,
    string FilePath,
    int Line,
    int Depth
);

// Roslyn analyzer service
class RoslynAnalyzer
{
    private readonly Dictionary<string, (Solution solution, DateTime loadedAt)> _solutionCache = new();
    private readonly TimeSpan _cacheExpiry = TimeSpan.FromMinutes(5);

    public async Task<Solution> LoadSolutionAsync(string solutionPath)
    {
        // Check cache
        if (_solutionCache.TryGetValue(solutionPath, out var cached))
        {
            if (DateTime.UtcNow - cached.loadedAt < _cacheExpiry)
            {
                return cached.solution;
            }
        }

        var workspace = MSBuildWorkspace.Create();
        var solution = await workspace.OpenSolutionAsync(solutionPath);

        _solutionCache[solutionPath] = (solution, DateTime.UtcNow);
        return solution;
    }

    public async Task<AnalysisResult> AnalyzeSolutionAsync(string solutionPath)
    {
        var solution = await LoadSolutionAsync(solutionPath);
        var symbols = new List<SymbolInfo>();
        int classes = 0, interfaces = 0, methods = 0;

        foreach (var project in solution.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            if (compilation == null) continue;

            foreach (var tree in compilation.SyntaxTrees)
            {
                var root = await tree.GetRootAsync();
                var semanticModel = compilation.GetSemanticModel(tree);
                var filePath = tree.FilePath;

                // Find classes
                foreach (var classDecl in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
                {
                    var symbol = semanticModel.GetDeclaredSymbol(classDecl);
                    if (symbol != null)
                    {
                        classes++;
                        symbols.Add(CreateSymbolInfo(symbol, classDecl, filePath));
                    }
                }

                // Find interfaces
                foreach (var interfaceDecl in root.DescendantNodes().OfType<InterfaceDeclarationSyntax>())
                {
                    var symbol = semanticModel.GetDeclaredSymbol(interfaceDecl);
                    if (symbol != null)
                    {
                        interfaces++;
                        symbols.Add(CreateSymbolInfo(symbol, interfaceDecl, filePath));
                    }
                }

                // Find methods
                foreach (var methodDecl in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
                {
                    var symbol = semanticModel.GetDeclaredSymbol(methodDecl);
                    if (symbol != null)
                    {
                        methods++;
                        symbols.Add(CreateSymbolInfo(symbol, methodDecl, filePath));
                    }
                }
            }
        }

        return new AnalysisResult(
            TotalSymbols: symbols.Count,
            Classes: classes,
            Interfaces: interfaces,
            Methods: methods,
            Symbols: symbols
        );
    }

    public async Task<List<SymbolInfo>> FindSymbolAsync(string solutionPath, string symbolName)
    {
        var solution = await LoadSolutionAsync(solutionPath);
        var results = new List<SymbolInfo>();

        foreach (var project in solution.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            if (compilation == null) continue;

            // Search for symbols matching the name
            var symbols = compilation.GetSymbolsWithName(
                name => name.Contains(symbolName, StringComparison.OrdinalIgnoreCase),
                SymbolFilter.All
            );

            foreach (var symbol in symbols)
            {
                var location = symbol.Locations.FirstOrDefault();
                if (location?.IsInSource == true)
                {
                    var tree = location.SourceTree;
                    var node = await tree!.GetRootAsync()
                        .ContinueWith(t => t.Result.FindNode(location.SourceSpan));

                    results.Add(CreateSymbolInfo(symbol, node, tree.FilePath));
                }
            }
        }

        return results;
    }

    public async Task<List<ReferenceInfo>> FindReferencesAsync(
        string solutionPath, string filePath, int line, int column)
    {
        var solution = await LoadSolutionAsync(solutionPath);
        var results = new List<ReferenceInfo>();

        var document = solution.Projects
            .SelectMany(p => p.Documents)
            .FirstOrDefault(d => d.FilePath == filePath);

        if (document == null) return results;

        var semanticModel = await document.GetSemanticModelAsync();
        var root = await document.GetSyntaxRootAsync();
        if (semanticModel == null || root == null) return results;

        // Find symbol at position
        var position = root.GetLocation().SourceTree!
            .GetText().Lines[line - 1].Start + column;

        var symbolInfo = semanticModel.GetSymbolInfo(root.FindToken(position).Parent!);
        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();

        if (symbol == null) return results;

        // Find all references
        var references = await SymbolFinder.FindReferencesAsync(symbol, solution);

        foreach (var reference in references)
        {
            foreach (var location in reference.Locations)
            {
                var refDocument = location.Document;
                var refRoot = await refDocument.GetSyntaxRootAsync();
                var span = location.Location.SourceSpan;

                var lineSpan = refRoot!.GetLocation().SourceTree!
                    .GetLineSpan(span);

                results.Add(new ReferenceInfo(
                    FilePath: refDocument.FilePath ?? "",
                    Line: lineSpan.StartLinePosition.Line + 1,
                    Column: lineSpan.StartLinePosition.Character,
                    Context: refRoot.FindNode(span).Parent?.ToString() ?? ""
                ));
            }
        }

        return results;
    }

    public async Task<List<SymbolInfo>> FindImplementationsAsync(
        string solutionPath, string interfaceName)
    {
        var solution = await LoadSolutionAsync(solutionPath);
        var results = new List<SymbolInfo>();

        foreach (var project in solution.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            if (compilation == null) continue;

            // Find the interface
            var interfaceSymbols = compilation.GetSymbolsWithName(
                name => name == interfaceName,
                SymbolFilter.Type
            ).OfType<INamedTypeSymbol>().Where(s => s.TypeKind == TypeKind.Interface);

            foreach (var interfaceSymbol in interfaceSymbols)
            {
                var implementations = await SymbolFinder.FindImplementationsAsync(
                    interfaceSymbol, solution);

                foreach (var impl in implementations)
                {
                    var location = impl.Locations.FirstOrDefault();
                    if (location?.IsInSource == true)
                    {
                        var tree = location.SourceTree;
                        var node = (await tree!.GetRootAsync()).FindNode(location.SourceSpan);
                        results.Add(CreateSymbolInfo(impl, node, tree.FilePath));
                    }
                }
            }
        }

        return results;
    }

    public async Task<List<CallInfo>> GetCallHierarchyAsync(
        string solutionPath, string filePath, int line, int column, string direction)
    {
        var solution = await LoadSolutionAsync(solutionPath);
        var results = new List<CallInfo>();

        var document = solution.Projects
            .SelectMany(p => p.Documents)
            .FirstOrDefault(d => d.FilePath == filePath);

        if (document == null) return results;

        var semanticModel = await document.GetSemanticModelAsync();
        var root = await document.GetSyntaxRootAsync();
        if (semanticModel == null || root == null) return results;

        // Find symbol at position
        var text = await document.GetTextAsync();
        var position = text.Lines[line - 1].Start + column;

        var token = root.FindToken(position);
        var node = token.Parent;
        while (node != null && node is not MethodDeclarationSyntax)
        {
            node = node.Parent;
        }

        if (node is not MethodDeclarationSyntax methodDecl) return results;

        var symbol = semanticModel.GetDeclaredSymbol(methodDecl);
        if (symbol == null) return results;

        if (direction == "incoming")
        {
            // Find callers
            var callers = await SymbolFinder.FindCallersAsync(symbol, solution);
            foreach (var caller in callers)
            {
                var callerLocation = caller.CallingSymbol.Locations.FirstOrDefault();
                if (callerLocation?.IsInSource == true)
                {
                    var lineSpan = callerLocation.GetLineSpan();
                    results.Add(new CallInfo(
                        SymbolName: caller.CallingSymbol.Name,
                        FilePath: callerLocation.SourceTree?.FilePath ?? "",
                        Line: lineSpan.StartLinePosition.Line + 1,
                        Depth: 1
                    ));
                }
            }
        }
        else
        {
            // Find callees (methods called by this method)
            var invocations = methodDecl.DescendantNodes()
                .OfType<InvocationExpressionSyntax>();

            foreach (var invocation in invocations)
            {
                var invokedSymbol = semanticModel.GetSymbolInfo(invocation).Symbol;
                if (invokedSymbol is IMethodSymbol calledMethod)
                {
                    var calleeLocation = calledMethod.Locations.FirstOrDefault();
                    var lineSpan = invocation.GetLocation().GetLineSpan();

                    results.Add(new CallInfo(
                        SymbolName: calledMethod.Name,
                        FilePath: calleeLocation?.SourceTree?.FilePath ?? "(external)",
                        Line: lineSpan.StartLinePosition.Line + 1,
                        Depth: 1
                    ));
                }
            }
        }

        return results;
    }

    private static SymbolInfo CreateSymbolInfo(ISymbol symbol, SyntaxNode node, string filePath)
    {
        var lineSpan = node.GetLocation().GetLineSpan();

        string? signature = null;
        string? returnType = null;
        string[]? modifiers = null;

        if (symbol is IMethodSymbol method)
        {
            signature = method.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            returnType = method.ReturnType.ToDisplayString();
        }
        else if (symbol is INamedTypeSymbol type)
        {
            signature = type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        }

        var accessibility = symbol.DeclaredAccessibility.ToString().ToLower();
        var modifierList = new List<string> { accessibility };
        if (symbol.IsStatic) modifierList.Add("static");
        if (symbol.IsAbstract) modifierList.Add("abstract");
        if (symbol.IsVirtual) modifierList.Add("virtual");
        if (symbol.IsOverride) modifierList.Add("override");
        if (symbol.IsSealed) modifierList.Add("sealed");
        modifiers = modifierList.ToArray();

        return new SymbolInfo(
            Name: symbol.Name,
            QualifiedName: symbol.ToDisplayString(),
            Kind: symbol.Kind.ToString(),
            FilePath: filePath,
            LineStart: lineSpan.StartLinePosition.Line + 1,
            LineEnd: lineSpan.EndLinePosition.Line + 1,
            Signature: signature,
            Namespace: symbol.ContainingNamespace?.ToDisplayString(),
            Modifiers: modifiers,
            ReturnType: returnType
        );
    }
}
