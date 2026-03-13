"""
Code parsers using tree-sitter for symbol extraction.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import tree_sitter_c_sharp as ts_csharp
import tree_sitter_javascript as ts_javascript
import tree_sitter_python as ts_python
import tree_sitter_typescript as ts_typescript
from tree_sitter import Language, Parser


@dataclass
class Symbol:
    """Represents a code symbol (class, method, function, etc.)."""

    name: str
    qualified_name: str
    symbol_type: str  # class, interface, method, function, property, field, enum
    language: str
    namespace: str = ""
    signature: str = ""
    docstring: str = ""
    code_preview: str = ""
    line_start: int = 0
    line_end: int = 0
    modifiers: list[str] = field(default_factory=list)
    return_type: str = ""
    parameters: list[str] = field(default_factory=list)


# Language configurations
LANGUAGE_CONFIG = {
    ".cs": {
        "language": Language(ts_csharp.language()),
        "name": "csharp",
        "symbol_queries": {
            "class": "(class_declaration name: (identifier) @name) @class",
            "interface": "(interface_declaration name: (identifier) @name) @interface",
            "method": "(method_declaration name: (identifier) @name) @method",
            "property": "(property_declaration name: (identifier) @name) @property",
            "field": "(field_declaration (variable_declaration (variable_declarator (identifier) @name))) @field",
            "enum": "(enum_declaration name: (identifier) @name) @enum",
        },
    },
    ".ts": {
        "language": Language(ts_typescript.language_typescript()),
        "name": "typescript",
        "symbol_queries": {
            "class": "(class_declaration name: (type_identifier) @name) @class",
            "interface": "(interface_declaration name: (type_identifier) @name) @interface",
            "function": "(function_declaration name: (identifier) @name) @function",
            "method": "(method_definition name: (property_identifier) @name) @method",
            "type": "(type_alias_declaration name: (type_identifier) @name) @type",
        },
    },
    ".tsx": {
        "language": Language(ts_typescript.language_tsx()),
        "name": "typescript",
        "symbol_queries": {
            "class": "(class_declaration name: (type_identifier) @name) @class",
            "interface": "(interface_declaration name: (type_identifier) @name) @interface",
            "function": "(function_declaration name: (identifier) @name) @function",
            "method": "(method_definition name: (property_identifier) @name) @method",
            "type": "(type_alias_declaration name: (type_identifier) @name) @type",
        },
    },
    ".js": {
        "language": Language(ts_javascript.language()),
        "name": "javascript",
        "symbol_queries": {
            "class": "(class_declaration name: (identifier) @name) @class",
            "function": "(function_declaration name: (identifier) @name) @function",
            "method": "(method_definition name: (property_identifier) @name) @method",
        },
    },
    ".jsx": {
        "language": Language(ts_javascript.language()),
        "name": "javascript",
        "symbol_queries": {
            "class": "(class_declaration name: (identifier) @name) @class",
            "function": "(function_declaration name: (identifier) @name) @function",
            "method": "(method_definition name: (property_identifier) @name) @method",
        },
    },
    ".py": {
        "language": Language(ts_python.language()),
        "name": "python",
        "symbol_queries": {
            "class": "(class_definition name: (identifier) @name) @class",
            "function": "(function_definition name: (identifier) @name) @function",
        },
    },
}


def get_parser(extension: str) -> Optional[tuple[Parser, dict, str]]:
    """Get parser and queries for a file extension."""
    config = LANGUAGE_CONFIG.get(extension)
    if not config:
        return None

    parser = Parser(config["language"])
    return parser, config["symbol_queries"], config["name"]


def extract_docstring(node, source: bytes, language: str) -> str:
    """Extract documentation comment before a node."""
    # Get the previous sibling or comment before the node
    prev = node.prev_sibling
    if prev is None:
        return ""

    # Handle different comment styles
    if language == "csharp":
        # Look for /// comments
        comments = []
        while prev and prev.type in ("comment", "documentation_comment"):
            comments.insert(0, source[prev.start_byte : prev.end_byte].decode("utf-8"))
            prev = prev.prev_sibling
        return "\n".join(comments)

    elif language == "python":
        # Look for docstring (first string in function/class body)
        body = node.child_by_field_name("body")
        if body and body.child_count > 0:
            first_stmt = body.children[0]
            if first_stmt.type == "expression_statement":
                expr = first_stmt.children[0] if first_stmt.children else None
                if expr and expr.type == "string":
                    return source[expr.start_byte : expr.end_byte].decode("utf-8")
        return ""

    elif language in ("typescript", "javascript"):
        # Look for JSDoc comments
        if prev.type == "comment":
            text = source[prev.start_byte : prev.end_byte].decode("utf-8")
            if text.startswith("/**"):
                return text
        return ""

    return ""


def extract_signature(node, source: bytes, language: str, symbol_type: str) -> str:
    """Extract the signature of a symbol."""
    if symbol_type in ("class", "interface", "enum"):
        # Just use the first line
        text = source[node.start_byte : node.end_byte].decode("utf-8")
        first_line = text.split("\n")[0].strip()
        return first_line.rstrip("{").strip()

    elif symbol_type in ("method", "function"):
        # Get parameters and return type
        if language == "csharp":
            # Find return type, name, and parameters
            return_type = node.child_by_field_name("type")
            name = node.child_by_field_name("name")
            params = node.child_by_field_name("parameters")

            parts = []
            if return_type:
                parts.append(source[return_type.start_byte : return_type.end_byte].decode("utf-8"))
            if name:
                parts.append(source[name.start_byte : name.end_byte].decode("utf-8"))
            if params:
                parts.append(source[params.start_byte : params.end_byte].decode("utf-8"))

            return " ".join(parts) if parts else ""

        else:
            # Generic: use first line up to opening brace
            text = source[node.start_byte : node.end_byte].decode("utf-8")
            first_line = text.split("\n")[0].strip()
            return first_line.rstrip("{").strip()

    return ""


def extract_modifiers(node, source: bytes, language: str) -> list[str]:
    """Extract modifiers like public, static, async, etc."""
    modifiers = []

    if language == "csharp":
        for child in node.children:
            if child.type == "modifier":
                modifiers.append(source[child.start_byte : child.end_byte].decode("utf-8"))

    elif language in ("typescript", "javascript"):
        # Check for export, async, static keywords
        text = source[node.start_byte : node.end_byte].decode("utf-8")
        first_line = text.split("\n")[0]
        if "export" in first_line:
            modifiers.append("export")
        if "async" in first_line:
            modifiers.append("async")
        if "static" in first_line:
            modifiers.append("static")

    return modifiers


def extract_return_type(node, source: bytes, language: str) -> str:
    """Extract return type of a method/function."""
    if language == "csharp":
        type_node = node.child_by_field_name("type")
        if type_node:
            return source[type_node.start_byte : type_node.end_byte].decode("utf-8")

    elif language == "typescript":
        # Look for return_type annotation
        for child in node.children:
            if child.type == "type_annotation":
                return source[child.start_byte : child.end_byte].decode("utf-8").lstrip(": ")

    return ""


def extract_namespace(node, source: bytes, language: str) -> str:
    """Extract namespace/module containing the symbol."""
    if language == "csharp":
        # Walk up to find namespace declaration
        current = node.parent
        while current:
            if current.type == "namespace_declaration":
                name = current.child_by_field_name("name")
                if name:
                    return source[name.start_byte : name.end_byte].decode("utf-8")
            current = current.parent

    elif language in ("typescript", "javascript"):
        # Could extract from module path or file structure
        pass

    return ""


def parse_file(file_path: Path) -> list[Symbol]:
    """Parse a source file and extract symbols."""
    extension = file_path.suffix.lower()
    parser_info = get_parser(extension)

    if not parser_info:
        return []

    parser, queries, language = parser_info

    try:
        source = file_path.read_bytes()
        tree = parser.parse(source)
    except Exception:
        return []

    symbols = []
    root = tree.root_node

    for symbol_type, query_str in queries.items():
        try:
            query = parser.language.query(query_str)
            captures = query.captures(root)

            for node, capture_name in captures:
                if capture_name == symbol_type:
                    # Find the name capture
                    name_text = ""
                    for child_node, child_name in captures:
                        if child_name == "name" and child_node.parent == node:
                            name_text = source[child_node.start_byte : child_node.end_byte].decode("utf-8")
                            break

                    if not name_text:
                        # Fallback: try to get name from node field
                        name_node = node.child_by_field_name("name")
                        if name_node:
                            name_text = source[name_node.start_byte : name_node.end_byte].decode("utf-8")

                    if name_text:
                        namespace = extract_namespace(node, source, language)
                        qualified_name = f"{namespace}.{name_text}" if namespace else name_text

                        symbol = Symbol(
                            name=name_text,
                            qualified_name=qualified_name,
                            symbol_type=symbol_type,
                            language=language,
                            namespace=namespace,
                            signature=extract_signature(node, source, language, symbol_type),
                            docstring=extract_docstring(node, source, language),
                            code_preview=source[node.start_byte : node.end_byte].decode("utf-8")[:1000],
                            line_start=node.start_point[0] + 1,
                            line_end=node.end_point[0] + 1,
                            modifiers=extract_modifiers(node, source, language),
                            return_type=extract_return_type(node, source, language),
                        )
                        symbols.append(symbol)

        except Exception:
            # Query might not match this language version
            continue

    return symbols
