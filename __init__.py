import os
from aiohttp import web
from server import PromptServer  # type: ignore

class imgInfo:
    """Main entry point for imgInfo plugin"""

    @classmethod
    def add_routes(cls):
        """Initialize and register all routes for templates and static files."""
        app = PromptServer.instance.app

        # Absolute paths to the static directory
        base_dir = os.path.dirname(__file__)
        static_dir = os.path.join(base_dir, "static")

        # Serve static files
        app.router.add_static('/comfyui_otacoo/static', static_dir)

        # Serve imginfo.html at /imginfo
        async def serve_imginfo(request):
            return web.FileResponse(os.path.join(static_dir, "imginfo.html"))

        app.router.add_routes([web.get('/imginfo', serve_imginfo)])

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./js"

# Register routes on import
imgInfo.add_routes()
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]