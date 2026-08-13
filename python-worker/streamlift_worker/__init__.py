"""StreamLift Worker — distributed download agent for Google Colab."""

try:
    # Populated by setuptools-scm at build time from the Git tag.
    from streamlift_worker._version import version as __version__
except ImportError:
    # Running from source without a build (e.g. direct git clone).
    __version__ = "0.0.0.dev0"
