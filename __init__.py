import os
from aiohttp import web
from server import PromptServer  # type: ignore

class imgExtractor:

    @classmethod
    def add_routes(cls):
        """Initialize and register all routes for templates and static files."""
        app = PromptServer.instance.app

        # Absolute paths to the static directory
        base_dir = os.path.dirname(__file__)
        static_dir = os.path.join(base_dir, "static")

        # Serve static files
        app.router.add_static('/comfyui_metadata_extract/static', static_dir)

        # Serve imgextract.html at /imgextract
        async def serve_imgextract(request):
            return web.FileResponse(os.path.join(static_dir, "imgextract.html"))

        app.router.add_routes([web.get('/imgextract', serve_imgextract)])

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./js"

# Register routes on import
imgExtractor.add_routes()
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]