# Licences and clean-room record

## Our own work
All source code, styles, copy text and room names in this repository were written for this project.
The visual design (palette, layout, numbered menus, typography choices) was designed from written
requirements, not from screenshots or archives of any other service.

When you add a screen, note the requirement it came from in your design log. Do not use captures,
archived pages, or recollected pixel layouts of other chat services as references.

## Assets
| Asset | Source | Licence |
| --- | --- | --- |
| Fonts | System fonts only (Verdana / DejaVu Sans / system UI) | Not redistributed |
| Icons / images | None yet | — |
| Sounds | None yet | — |

Add a row for every font, icon, image or sound you introduce, with its licence.

## Dependencies
Runtime: fastify, @fastify/cookie, @fastify/static, socket.io, @socket.io/redis-adapter, ioredis,
pg, zod, dotenv — all MIT or similarly permissive. Run `npx license-checker --summary` after
installing to confirm before release.
