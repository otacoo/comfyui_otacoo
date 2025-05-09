import os

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY", "setup"]

def setup(app):
    static_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "web"))
    app.router.add_static('/imginfo', static_path)
