# prisma-usage

Mide en tiempo real el uso de Claude Code en cada PC y lo reporta a PrismaMind, por llamada a la API y por tool.
Además deja un registro local para depurar sesiones caras y tools que fallan.

## Instalar

Requiere Node 20+ en el PATH (los hooks son `node`). Sin dependencias, sin build.

```
/plugin marketplace add PrismaMCNetwork/prisma-usage
/plugin install prisma-usage@prisma-tools
```

El plugin trae la URL (`defaults.json`) pero **no el token** (el repo es público): después de instalar, pedile el token a PrismaMC y corré `/prisma-usage setup <url> <token>` (la URL es `https://prismamc.net/api/public/claude-usage`). Sin token no se reporta nada y queda solo el registro local. También sirven las variables `PRISMA_USAGE_URL` / `PRISMA_USAGE_TOKEN`. Para no reportar nada (queda solo el registro local): `PRISMA_USAGE_DISABLE=1`.

## Qué hace

- Hooks `PreToolUse`/`PostToolUse`/`PostToolUseFailure` miden cada tool (duración exacta, ok/falló, bytes del resultado).
- Todos los hooks (`SessionStart`, `UserPromptSubmit`, `SubagentStop`, `PreCompact`, `Stop`, `SessionEnd`) leen lo nuevo
  del transcript y extraen las llamadas a la API con sus tokens reales (input, output, caché leída/escrita).
- Los eventos van a una cola en disco y un proceso aparte los envía (nunca demora la sesión; sin red no se pierde nada).
- Cada hook sale siempre con código 0 y sin imprimir nada: solo observa.

## Comandos

`/prisma-usage` (24 h) · `week` · `tools` · `errors` · `sessions` · `status` · `what-is-sent` · `setup <url> <token>`

## Qué se envía (y qué no)

Se envía: nombre de la PC, usuario del SO, hash del id de máquina, git user/email, correo de la cuenta Claude; por llamada:
modelo, tokens, motivo de parada, cantidad de tools pedidas, id de sesión, nombre de la carpeta del proyecto; por tool:
nombre, duración, ok/falló, clase corta del fallo, tamaño del resultado en bytes.

**Nunca** se envía: prompts, respuestas, contenido de archivos, comandos, entradas/salidas de tools ni mensajes de error.
`/prisma-usage what-is-sent` lo muestra, y los mismos eventos quedan en `~/.prisma-usage/events.jsonl`.

## Archivos locales (`~/.prisma-usage/`, cambiable con `PRISMA_USAGE_HOME`)

`config.json` (url+token) · `identity.json` · `spool.jsonl` (cola) · `events.jsonl` (registro local, rota a 5 MB) ·
`errors.log` (fallos del propio plugin) · `state/` (offset por sesión) · `pending/` (tools en curso).
