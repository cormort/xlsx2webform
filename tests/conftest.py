import os

# Must be set before backend.main is imported (it checks at module level)
os.environ.setdefault("ADMIN_PASSWORD", "testpw")
