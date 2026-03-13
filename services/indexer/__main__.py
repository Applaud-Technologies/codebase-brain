"""
Codebase Brain Indexer

Watches repositories for changes and maintains indexes in:
- Qdrant (semantic embeddings)
- Neo4j (code graph)
- Zoekt (lexical search - via external indexer)
"""

import asyncio
import hashlib
import os
import time
from pathlib import Path
from typing import Optional

import httpx
import structlog
from git import Repo
from neo4j import AsyncGraphDatabase
from pydantic import BaseModel
from pydantic_settings import BaseSettings
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .parsers import parse_file, Symbol

log = structlog.get_logger()


class Settings(BaseSettings):
    repos_root: str = "/repos"
    qdrant_url: str = "http://qdrant:6333"
    neo4j_url: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "codebase-brain-dev"
    zoekt_url: str = "http://zoekt:6070"
    ollama_url: str = "http://host.docker.internal:11434"
    embedding_model: str = "all-minilm"
    embedding_dimensions: int = 384  # all-minilm=384, nomic=768, mxbai=1024
    watch_interval: int = 5  # seconds
    batch_size: int = 50

    class Config:
        env_prefix = ""


settings = Settings()


class IndexState(BaseModel):
    """Tracks indexing state per file."""
    file_path: str
    git_hash: str
    indexed_at: float
    symbol_count: int


class EmbeddingClient:
    """Client for generating embeddings via Ollama."""

    def __init__(self, base_url: str, model: str):
        self.base_url = base_url
        self.model = model
        self.client = httpx.AsyncClient(timeout=60.0)

    async def embed(self, text: str) -> list[float]:
        response = await self.client.post(
            f"{self.base_url}/api/embeddings",
            json={"model": self.model, "prompt": text},
        )
        response.raise_for_status()
        return response.json()["embedding"]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        # Ollama doesn't support batch embedding, so we parallelize
        tasks = [self.embed(text) for text in texts]
        return await asyncio.gather(*tasks)


class CodebaseIndexer:
    """Main indexer class that coordinates all indexing operations."""

    def __init__(self):
        self.qdrant: Optional[AsyncQdrantClient] = None
        self.neo4j_driver = None
        self.embedding_client = EmbeddingClient(
            settings.ollama_url, settings.embedding_model
        )
        self.index_state: dict[str, IndexState] = {}

    async def initialize(self):
        """Initialize connections to storage backends."""
        log.info("Initializing indexer", qdrant_url=settings.qdrant_url)

        # Initialize Qdrant
        self.qdrant = AsyncQdrantClient(url=settings.qdrant_url)

        # Create collection if it doesn't exist
        collections = await self.qdrant.get_collections()
        collection_names = [c.name for c in collections.collections]

        if "code_chunks" not in collection_names:
            await self.qdrant.create_collection(
                collection_name="code_chunks",
                vectors_config=VectorParams(
                    size=settings.embedding_dimensions,
                    distance=Distance.COSINE,
                    on_disk=True,
                ),
            )
            log.info("Created Qdrant collection: code_chunks")

        # Initialize Neo4j
        self.neo4j_driver = AsyncGraphDatabase.driver(
            settings.neo4j_url,
            auth=(settings.neo4j_user, settings.neo4j_password),
        )

        # Verify connection
        async with self.neo4j_driver.session() as session:
            await session.run("RETURN 1")

        log.info("Indexer initialized successfully")

    async def close(self):
        """Clean up connections."""
        if self.qdrant:
            await self.qdrant.close()
        if self.neo4j_driver:
            await self.neo4j_driver.close()

    def should_index_file(self, file_path: Path) -> bool:
        """Check if a file should be indexed based on extension."""
        supported_extensions = {
            ".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go"
        }
        return file_path.suffix.lower() in supported_extensions

    def get_file_hash(self, file_path: Path) -> str:
        """Get hash of file contents for change detection."""
        content = file_path.read_bytes()
        return hashlib.sha256(content).hexdigest()[:16]

    async def index_file(self, file_path: Path, repo_id: str) -> int:
        """Index a single file, returns number of symbols indexed."""
        if not self.should_index_file(file_path):
            return 0

        file_hash = self.get_file_hash(file_path)
        rel_path = str(file_path.relative_to(settings.repos_root))

        # Check if already indexed with same hash
        state = self.index_state.get(rel_path)
        if state and state.git_hash == file_hash:
            return 0

        log.debug("Indexing file", file=rel_path)

        try:
            # Parse symbols from file
            symbols = parse_file(file_path)
            if not symbols:
                return 0

            # Generate embeddings for symbols
            texts = [self._symbol_to_text(s) for s in symbols]
            embeddings = await self.embedding_client.embed_batch(texts)

            # Upsert to Qdrant
            points = []
            for symbol, embedding in zip(symbols, embeddings):
                point_id = self._symbol_id(repo_id, rel_path, symbol)
                points.append(
                    PointStruct(
                        id=point_id,
                        vector=embedding,
                        payload={
                            "symbol_id": point_id,
                            "symbol_type": symbol.symbol_type,
                            "name": symbol.name,
                            "qualified_name": symbol.qualified_name,
                            "file_path": rel_path,
                            "line_start": symbol.line_start,
                            "line_end": symbol.line_end,
                            "language": symbol.language,
                            "namespace": symbol.namespace,
                            "signature": symbol.signature,
                            "docstring": symbol.docstring,
                            "code_preview": symbol.code_preview[:500],
                            "modifiers": symbol.modifiers,
                            "return_type": symbol.return_type,
                            "repo_id": repo_id,
                            "last_indexed": time.time(),
                            "git_hash": file_hash,
                        },
                    )
                )

            if points:
                await self.qdrant.upsert(
                    collection_name="code_chunks",
                    points=points,
                )

            # Update Neo4j graph
            await self._update_graph(repo_id, rel_path, symbols)

            # Update state
            self.index_state[rel_path] = IndexState(
                file_path=rel_path,
                git_hash=file_hash,
                indexed_at=time.time(),
                symbol_count=len(symbols),
            )

            log.info("Indexed file", file=rel_path, symbols=len(symbols))
            return len(symbols)

        except Exception as e:
            log.error("Failed to index file", file=rel_path, error=str(e))
            return 0

    def _symbol_to_text(self, symbol: Symbol) -> str:
        """Convert symbol to text for embedding."""
        parts = []
        if symbol.docstring:
            parts.append(symbol.docstring)
        parts.append(f"{symbol.symbol_type} {symbol.name}")
        if symbol.signature:
            parts.append(symbol.signature)
        if symbol.code_preview:
            parts.append(symbol.code_preview[:300])
        return "\n".join(parts)

    def _symbol_id(self, repo_id: str, file_path: str, symbol: Symbol) -> str:
        """Generate unique ID for a symbol."""
        raw = f"{repo_id}:{file_path}:{symbol.line_start}:{symbol.name}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    async def _update_graph(
        self, repo_id: str, file_path: str, symbols: list[Symbol]
    ):
        """Update Neo4j graph with symbol relationships."""
        async with self.neo4j_driver.session() as session:
            # Create/update file node
            await session.run(
                """
                MERGE (f:File {path: $path})
                SET f.repo_id = $repo_id,
                    f.language = $language,
                    f.last_indexed = timestamp()
                """,
                path=file_path,
                repo_id=repo_id,
                language=symbols[0].language if symbols else "unknown",
            )

            # Create symbol nodes
            for symbol in symbols:
                symbol_id = self._symbol_id(repo_id, file_path, symbol)
                await session.run(
                    """
                    MERGE (s:Symbol {id: $id})
                    SET s.name = $name,
                        s.qualified_name = $qualified_name,
                        s.symbol_type = $symbol_type,
                        s.signature = $signature,
                        s.language = $language,
                        s.namespace = $namespace,
                        s.line_start = $line_start,
                        s.line_end = $line_end,
                        s.modifiers = $modifiers,
                        s.return_type = $return_type,
                        s.is_test = $is_test
                    MERGE (s)-[:DEFINED_IN]->(:File {path: $file_path})
                    """,
                    id=symbol_id,
                    name=symbol.name,
                    qualified_name=symbol.qualified_name,
                    symbol_type=symbol.symbol_type,
                    signature=symbol.signature,
                    language=symbol.language,
                    namespace=symbol.namespace,
                    line_start=symbol.line_start,
                    line_end=symbol.line_end,
                    modifiers=symbol.modifiers,
                    return_type=symbol.return_type,
                    is_test="test" in file_path.lower(),
                    file_path=file_path,
                )

    async def index_repository(self, repo_path: Path) -> int:
        """Index an entire repository."""
        repo_id = repo_path.name
        log.info("Indexing repository", repo=repo_id)

        total_symbols = 0
        for file_path in repo_path.rglob("*"):
            if file_path.is_file() and self.should_index_file(file_path):
                total_symbols += await self.index_file(file_path, repo_id)

        log.info("Repository indexed", repo=repo_id, total_symbols=total_symbols)
        return total_symbols

    async def full_index(self):
        """Index all repositories in the repos root."""
        repos_root = Path(settings.repos_root)
        if not repos_root.exists():
            log.warning("Repos root does not exist", path=settings.repos_root)
            return

        # Find all git repositories
        for item in repos_root.iterdir():
            if item.is_dir():
                git_dir = item / ".git"
                if git_dir.exists():
                    await self.index_repository(item)


class FileChangeHandler(FileSystemEventHandler):
    """Handles file system events for incremental indexing."""

    def __init__(self, indexer: CodebaseIndexer):
        self.indexer = indexer
        self.pending_files: set[Path] = set()
        self._lock = asyncio.Lock()

    def on_modified(self, event):
        if not event.is_directory:
            self.pending_files.add(Path(event.src_path))

    def on_created(self, event):
        if not event.is_directory:
            self.pending_files.add(Path(event.src_path))

    async def process_pending(self):
        """Process all pending file changes."""
        async with self._lock:
            files = list(self.pending_files)
            self.pending_files.clear()

        for file_path in files:
            if file_path.exists():
                # Determine repo_id from path
                try:
                    rel = file_path.relative_to(settings.repos_root)
                    repo_id = rel.parts[0]
                    await self.indexer.index_file(file_path, repo_id)
                except ValueError:
                    pass


async def main():
    """Main entry point."""
    log.info("Starting Codebase Brain Indexer")

    indexer = CodebaseIndexer()
    await indexer.initialize()

    # Run full index first
    await indexer.full_index()

    # Set up file watcher for incremental updates
    handler = FileChangeHandler(indexer)
    observer = Observer()
    observer.schedule(handler, settings.repos_root, recursive=True)
    observer.start()

    log.info("Watching for file changes", path=settings.repos_root)

    try:
        while True:
            await asyncio.sleep(settings.watch_interval)
            await handler.process_pending()
    except KeyboardInterrupt:
        observer.stop()
        await indexer.close()

    observer.join()


if __name__ == "__main__":
    asyncio.run(main())
