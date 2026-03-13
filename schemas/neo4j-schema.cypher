// =============================================================================
// CODEBASE BRAIN - NEO4J GRAPH SCHEMA
// =============================================================================
// Run this to initialize the graph database with constraints and indexes

// -----------------------------------------------------------------------------
// CONSTRAINTS (unique identifiers)
// -----------------------------------------------------------------------------

CREATE CONSTRAINT symbol_id IF NOT EXISTS
FOR (s:Symbol) REQUIRE s.id IS UNIQUE;

CREATE CONSTRAINT file_path IF NOT EXISTS
FOR (f:File) REQUIRE f.path IS UNIQUE;

CREATE CONSTRAINT repo_id IF NOT EXISTS
FOR (r:Repository) REQUIRE r.id IS UNIQUE;

CREATE CONSTRAINT namespace_qualified IF NOT EXISTS
FOR (n:Namespace) REQUIRE n.qualified_name IS UNIQUE;

// -----------------------------------------------------------------------------
// INDEXES (query performance)
// -----------------------------------------------------------------------------

CREATE INDEX symbol_name IF NOT EXISTS
FOR (s:Symbol) ON (s.name);

CREATE INDEX symbol_type IF NOT EXISTS
FOR (s:Symbol) ON (s.symbol_type);

CREATE INDEX symbol_language IF NOT EXISTS
FOR (s:Symbol) ON (s.language);

CREATE INDEX file_language IF NOT EXISTS
FOR (f:File) ON (f.language);

CREATE INDEX namespace_name IF NOT EXISTS
FOR (n:Namespace) ON (n.name);

// Composite indexes for common queries
CREATE INDEX symbol_type_name IF NOT EXISTS
FOR (s:Symbol) ON (s.symbol_type, s.name);

// Full-text search index for symbol names
CREATE FULLTEXT INDEX symbol_search IF NOT EXISTS
FOR (s:Symbol) ON EACH [s.name, s.qualified_name];

// -----------------------------------------------------------------------------
// NODE LABELS
// -----------------------------------------------------------------------------
// :Symbol        - Any code symbol (class, method, interface, etc.)
// :File          - Source file
// :Repository    - Git repository
// :Namespace     - Namespace/module/package
// :Parameter     - Method parameter
// :ArchLayer     - Architectural layer (domain, application, infrastructure)

// -----------------------------------------------------------------------------
// SYMBOL SUBTYPES (additional labels on :Symbol nodes)
// -----------------------------------------------------------------------------
// :Class, :Interface, :Method, :Property, :Field, :Enum, :EnumMember
// :Function, :Type, :Constant, :Variable

// -----------------------------------------------------------------------------
// RELATIONSHIP TYPES
// -----------------------------------------------------------------------------

// File/Structure relationships
// (s:Symbol)-[:DEFINED_IN]->(f:File)
// (f:File)-[:IN_REPO]->(r:Repository)
// (s:Symbol)-[:IN_NAMESPACE]->(n:Namespace)
// (n:Namespace)-[:PARENT_NAMESPACE]->(n2:Namespace)

// Type hierarchy
// (c:Class)-[:EXTENDS]->(c2:Class)
// (c:Class)-[:IMPLEMENTS]->(i:Interface)
// (i:Interface)-[:EXTENDS]->(i2:Interface)

// Membership
// (m:Method)-[:MEMBER_OF]->(c:Class)
// (p:Property)-[:MEMBER_OF]->(c:Class)
// (f:Field)-[:MEMBER_OF]->(c:Class)

// Call graph
// (m:Method)-[:CALLS {line: int, count: int}]->(m2:Method)
// (m:Method)-[:READS]->(f:Field)
// (m:Method)-[:WRITES]->(f:Field)

// Dependencies
// (s:Symbol)-[:DEPENDS_ON]->(s2:Symbol)
// (s:Symbol)-[:USES_TYPE]->(t:Symbol)
// (m:Method)-[:RETURNS]->(t:Symbol)
// (m:Method)-[:HAS_PARAMETER {name: string, position: int}]->(t:Symbol)

// Architecture
// (n:Namespace)-[:BELONGS_TO]->(l:ArchLayer)
// (n:Namespace)-[:ALLOWED_DEPENDENCY]->(n2:Namespace)
// (n:Namespace)-[:FORBIDDEN_DEPENDENCY]->(n2:Namespace)

// -----------------------------------------------------------------------------
// EXAMPLE QUERIES
// -----------------------------------------------------------------------------

// Find all implementations of an interface:
// MATCH (i:Interface {name: 'IOrderService'})<-[:IMPLEMENTS]-(c:Class)
// RETURN c.name, c.file_path

// Find all callers of a method:
// MATCH (caller:Method)-[:CALLS]->(m:Method {name: 'CalculateTotal'})
// RETURN caller.qualified_name, caller.file_path

// Find methods with high fan-in (heavily used):
// MATCH (m:Method)<-[c:CALLS]-()
// WITH m, count(c) as fan_in
// WHERE fan_in > 10
// RETURN m.qualified_name, fan_in
// ORDER BY fan_in DESC

// Find potential duplicates by signature pattern:
// MATCH (m1:Method), (m2:Method)
// WHERE m1.signature = m2.signature
//   AND id(m1) < id(m2)
// RETURN m1.qualified_name, m2.qualified_name

// Centrality analysis (PageRank on call graph):
// CALL gds.pageRank.stream({
//   nodeProjection: 'Method',
//   relationshipProjection: 'CALLS'
// })
// YIELD nodeId, score
// RETURN gds.util.asNode(nodeId).qualified_name AS method, score
// ORDER BY score DESC LIMIT 20

// Architecture violation detection:
// MATCH (s1:Symbol)-[:IN_NAMESPACE]->(n1:Namespace)-[:FORBIDDEN_DEPENDENCY]->(n2:Namespace)<-[:IN_NAMESPACE]-(s2:Symbol)
// WHERE (s1)-[:DEPENDS_ON]->(s2)
// RETURN s1.qualified_name as violator, s2.qualified_name as forbidden_dep

// -----------------------------------------------------------------------------
// SYMBOL NODE PROPERTIES
// -----------------------------------------------------------------------------
// id:             string  - Unique identifier (repo:file:line:name)
// name:           string  - Simple name
// qualified_name: string  - Fully qualified name with namespace
// symbol_type:    string  - class, interface, method, property, field, enum
// language:       string  - csharp, typescript, python, etc.
// signature:      string  - Full signature including parameters and return type
// modifiers:      [string]- public, private, static, async, abstract, etc.
// return_type:    string  - Return type for methods/properties
// line_start:     int     - Starting line in file
// line_end:       int     - Ending line in file
// docstring:      string  - Documentation comment
// is_test:        bool    - Whether this is test code
// is_generated:   bool    - Whether this is generated code
// last_modified:  datetime- Git commit timestamp
// git_hash:       string  - Git commit hash when indexed

// -----------------------------------------------------------------------------
// FILE NODE PROPERTIES
// -----------------------------------------------------------------------------
// path:           string  - Relative path from repo root
// language:       string  - Detected language
// size_bytes:     int     - File size
// line_count:     int     - Number of lines
// is_test:        bool    - Whether this is a test file
// last_modified:  datetime

// -----------------------------------------------------------------------------
// MAINTENANCE QUERIES
// -----------------------------------------------------------------------------

// Delete all data for a repository (for re-indexing):
// MATCH (r:Repository {id: 'repo-id'})<-[:IN_REPO]-(f:File)<-[:DEFINED_IN]-(s:Symbol)
// DETACH DELETE s, f, r

// Find orphaned symbols (no file reference):
// MATCH (s:Symbol) WHERE NOT (s)-[:DEFINED_IN]->(:File)
// RETURN s.id
