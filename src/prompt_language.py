"""Response-language directive for system prompts.

Odysseus' internal prompts (tool protocol, JSON schemas, parser-sensitive
instructions) stay in English on purpose: models follow them most reliably and
several parsers depend on exact English tokens. What we localise is the
*language the assistant answers in*, by appending a short directive to the
system prompt.

Resolution order:
  1. settings key ``response_language`` (e.g. "es", "en", "auto")
  2. environment variable ``ODYSSEUS_LANGUAGE``
  3. fork default: "es"

``"auto"`` / ``"en"`` / empty add nothing (upstream behaviour).
"""
from __future__ import annotations

import os
from typing import Optional

DEFAULT_LANGUAGE = "es"

# lang -> directive (written in the target language so small models also pick it up)
_DIRECTIVES = {
    "es": (
        "\n\n## Idioma de respuesta\n"
        "Responde siempre en español (de España, tuteando) salvo que el usuario "
        "escriba en otro idioma o te pida expresamente otro. Mantén en su forma "
        "original los nombres de herramientas, comandos, rutas, código, claves "
        "JSON y cualquier identificador técnico; traduce solo el texto dirigido "
        "al usuario. Conserva las citas literales en su idioma original."
    ),
    "fr": (
        "\n\n## Langue de réponse\n"
        "Réponds toujours en français, sauf si l'utilisateur écrit dans une autre "
        "langue ou en demande explicitement une autre. Ne traduis pas les noms "
        "d'outils, commandes, chemins, code, clés JSON ni identifiants techniques."
    ),
}

_NO_DIRECTIVE = {"", "en", "auto", "none", "off"}


def response_language(setting_value: Optional[str] = None) -> str:
    """Return the effective response language code (lower-case, 2 letters)."""
    value = (setting_value or "").strip().lower()
    if not value:
        value = os.environ.get("ODYSSEUS_LANGUAGE", "").strip().lower()
    if not value:
        value = DEFAULT_LANGUAGE
    return value.split("-")[0].split("_")[0]


def language_directive(setting_value: Optional[str] = None) -> str:
    """Text to append to a system prompt ('' when no directive applies)."""
    lang = response_language(setting_value)
    if lang in _NO_DIRECTIVE:
        return ""
    return _DIRECTIVES.get(lang, "")


def with_language(prompt: str, setting_value: Optional[str] = None) -> str:
    """Append the directive once (idempotent)."""
    directive = language_directive(setting_value)
    if not directive or not isinstance(prompt, str):
        return prompt
    marker = directive.strip().splitlines()[0]
    if marker in prompt:
        return prompt
    return prompt + directive
