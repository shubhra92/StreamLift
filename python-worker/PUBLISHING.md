# Publishing Guide — streamlift-worker

## One-time PyPI Trusted Publishing setup

Do this once. You never need to store an API token anywhere.

1. Log in to [pypi.org](https://pypi.org)
2. Go to **Your projects → streamlift-worker → Manage → Publishing**  
   (If the project doesn't exist yet, go to **Account settings → Publishing** and add a pending publisher)
3. Click **Add a new publisher** and fill in:

   | Field | Value |
   |-------|-------|
   | PyPI project name | `streamlift-worker` |
   | Owner | your GitHub username |
   | Repository | `StreamLift` (your private repo name) |
   | Workflow filename | `publish-python-worker.yml` |
   | Environment name | `pypi` |

4. On GitHub, go to **Settings → Environments → New environment** and name it `pypi`.  
   No secrets needed — OIDC handles authentication automatically.

---

## How to release a new version

```bash
# 1. Make sure your changes are committed and on main
git checkout main
git pull

# 2. Tag the release — this is what drives the version number
git tag v1.2.0

# 3. Push the tag — this triggers the GitHub Actions workflow
git push origin v1.2.0
```

That's it. GitHub Actions will:
- Check out the repo with full history
- Build the wheel + sdist from `python-worker/` only
- Publish to PyPI via OIDC (no token needed)

The package will be live at `https://pypi.org/project/streamlift-worker/1.2.0/`  
within ~2 minutes of pushing the tag.

---

## Version numbering

The version is read directly from the Git tag by `setuptools-scm`:

| Git tag | PyPI version |
|---------|-------------|
| `v1.0.0` | `1.0.0` |
| `v1.2.3` | `1.2.3` |
| `v2.0.0-rc1` | `2.0.0rc1` |

**Do not set `version =` in `pyproject.toml`** — it's `dynamic` and will be wrong.

---

## Test locally before releasing

```bash
cd python-worker

# Create a clean virtual environment
python -m venv .venv
source .venv/bin/activate

# Install in editable mode with dev tools
pip install -e ".[dev]"

# Run a lint check
ruff check streamlift_worker/

# Build the package locally (output goes to dist/)
python -m build

# Inspect what's inside the wheel — make sure only streamlift_worker/ is there
unzip -l dist/streamlift_worker-*.whl

# Optional: do a dry-run upload to Test PyPI first
pip install twine
twine upload --repository testpypi dist/*
# Then test install from Test PyPI:
pip install --index-url https://test.pypi.org/simple/ streamlift-worker
```

---

## What's public vs private

| What | Visibility |
|------|-----------|
| Your GitHub repo (`StreamLift/`) | **Private** — only you |
| `express-backend/`, `next-frontend/`, etc. | **Private** — never leaves GitHub |
| `python-worker/streamlift_worker/*.py` | **Public** — included in the PyPI wheel |
| `python-worker/README.md`, `pyproject.toml` | **Public** — included in the sdist |
| `.env`, credentials, other configs | **Private** — excluded by `MANIFEST.in` |

> PyPI publishes only the built distribution files (`.whl` + `.tar.gz`).  
> It has no access to your GitHub repository at all.
