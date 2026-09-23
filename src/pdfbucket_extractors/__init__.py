"""Extraction plugin commands: each takes a PDF and an output directory.

These run as separate processes listed in `plugins/manifests/extractions.json`; the store
and the server never import them. Credentials come from the process environment.
"""
