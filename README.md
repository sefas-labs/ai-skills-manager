# AI Skills Manager

**Mira qué agente de IA carga realmente cada Agent Skill, detecta duplicados y skills rotos, e instala skills desde GitHub con revisión de seguridad.** Funciona en VS Code y en editores compatibles como Cursor.

Claude Code, Cursor, Codex y GitHub Copilot leen skills (`SKILL.md`) desde carpetas que se solapan, pero ninguna carpeta llega a los cuatro. Esta extensión lo muestra en un solo lugar.

Capturas en `docs/images/`.

## Qué hace (v0.2)

- **Inventario multi-agente:** escanea las carpetas globales y del workspace que cada agente lee según su documentación oficial, más las carpetas extra que configures.
  - **Monorepos:** también las carpetas padre hasta la raíz del repo (Claude Code, Codex) y las carpetas de skills anidadas (Claude Code, Cursor).
  - Incluye los skills sincronizados desde claude.ai (`~/.claude/skills/synced`, solo lectura).
- **Matriz de visibilidad:** qué agente carga qué carpeta y, por tanto, cada skill.
- **Diagnóstico:**
  - nombres duplicados que un mismo agente ve en dos carpetas distintas;
  - frontmatter inválido según [agentskills.io](https://agentskills.io/specification) (`name` ≠ carpeta, `description` ausente, longitudes);
  - `skill.md` con mayúsculas incorrectas;
  - symlinks rotos;
  - carpetas sin `SKILL.md`.
- **Instalar desde GitHub** (repo, carpeta, `…/blob/…/SKILL.md` u `owner/repo`):
  1. Analiza el repo y rechaza los que no son skills, indicando si parecen un plugin o un servidor MCP.
  2. Te deja elegir qué skills instalar.
  3. Descarga el **commit exacto** a una zona temporal y revisa todo el contenido.
  4. Te muestra qué agentes verán el skill según el destino que elijas.
  5. Pide confirmación antes de escribir nada.
- **Desinstalar con seguridad:** la carpeta va a un backup recuperable. Si es un symlink, solo se elimina el enlace.
- **Procedencia:** guarda repo, ref, commit y tree SHA de lo instalado. También lee la que escribe `gh skill install` en el SKILL.md.
- **Actualizaciones:** *Check for Updates* compara el tree SHA instalado con el remoto (2 llamadas a la API por repo y rama). *Update…* muestra antes los archivos añadidos, modificados y eliminados, tus cambios locales y la revisión de seguridad; después reemplaza la carpeta guardando un backup.
- **Copiar o mover** entre carpetas (global ↔ workspace, `.claude/skills` ↔ `.agents/skills`): antes de escribir, muestra qué agentes ganan y pierden el skill.
- Panel lateral, dashboard, temas claro/oscuro/alto contraste, Workspace Trust.

## Modelo de seguridad

- **Nunca ejecuta** nada de un repositorio. Los archivos se escriben **sin permiso de ejecución**.
- Revisión automática (heurística) de cada archivo:
  - Unicode invisible o bidireccional;
  - texto que intenta anular instrucciones del agente;
  - `curl … | sh` y `base64 -d | sh`;
  - envío de variables tipo `*_TOKEN`;
  - rutas de credenciales (`~/.ssh`, `~/.aws`);
  - binarios, scripts y comentarios HTML ocultos.

  Si hay hallazgos de riesgo alto, se pide una **segunda confirmación**. *Las heurísticas no garantizan seguridad: instala solo de fuentes en las que confíes.*
- Protección contra path traversal (rutas absolutas, `..`, nombres inválidos en Windows). Los symlinks y submódulos del repo se omiten.
- Nunca sobrescribe sin consentimiento. Lo reemplazado se guarda en backup, y ante un fallo hay rollback automático.
- El token de GitHub (opcional, desde la sesión del editor) vive solo en memoria, se envía únicamente a `api.github.com` y `raw.githubusercontent.com`, y nunca llega al webview.
- En **Restricted Mode** las carpetas del workspace son de solo lectura.
- Webview con CSP estricta (sin `unsafe-inline`), y todo el contenido se inserta como texto.

## Uso

- Icono **AI Skills** en la barra de actividad → árbol por alcance (Workspace / Global / Admin) → carpeta → skill. Clic en un skill para ver el detalle; botón derecho para Open, Reveal, Copy path, Copy or Move to…, Update… y Remove.
- Botones del panel: **Open Dashboard**, **Install from GitHub…**, **Refresh**.
- Paleta de comandos: `AI Skills: …`

### Ajustes

| Ajuste | Para qué |
|---|---|
| `skillsManager.providers` | Agentes a escanear (quita los que no uses) |
| `skillsManager.extraLocations` | Carpetas extra, p. ej. `{ "path": "~/.codeium/windsurf/skills", "readers": ["windsurf"] }` |
| `skillsManager.showEmptyLocations` | Mostrar carpetas existentes sin skills |
| `skillsManager.scanParentFolders` | Carpetas padre hasta la raíz del repo (por defecto: sí) |
| `skillsManager.scanNestedFolders` | Carpetas de skills anidadas en el workspace (por defecto: sí; profundidad máx. 6, omite `node_modules` y carpetas de build) |
| `skillsManager.checkForUpdatesOnStartup` | Comprobar actualizaciones al arrancar, como mucho cada 12 h (por defecto: no) |

## Desarrollo

Requisitos: Node 18+ y VS Code 1.90+.

```bash
npm install
npm run build        # esbuild → dist/
npm test             # 57 tests unitarios + integración (Node test runner, GitHub simulado)
npm run test:smoke   # carga dist/extension.js con una API de vscode simulada
npm run test:e2e     # ejecuta la extensión dentro de VS Code real (perfil temporal, proxy local, GitHub real)
node test/e2e/run.mjs /Applications/Cursor.app/Contents/MacOS/Cursor   # lo mismo en Cursor
npm run typecheck    # tsc con @types/vscode
```

### Ejecutar en VS Code

1. Abre esta carpeta en VS Code.
2. Pulsa **F5** (*Run Extension*) para abrir una ventana *Extension Development Host* con la extensión cargada. *Run Extension (clean profile)* la arranca sin tus otras extensiones.
3. Para ver datos, crea un skill de prueba:
   ```bash
   mkdir -p ~/.agents/skills/hola && printf -- '---\nname: hola\ndescription: Saluda. Úsalo para probar.\n---\nDi hola.\n' > ~/.agents/skills/hola/SKILL.md
   ```
4. Prueba una instalación real con `https://github.com/anthropics/skills`.

### Generar el VSIX

```bash
npm run build -- --production
npm run package             # oficial: @vscode/vsce → ai-skills-manager-0.2.0.vsix
# sin acceso a npm/vsce:
npm run package:offline     # empaquetador propio sin dependencias (scripts/package-vsix.mjs)
```

Instalar: `code --install-extension ai-skills-manager-0.2.0.vsix`, o en la paleta **Extensions: Install from VSIX…**

Para publicar en el Marketplace hace falta `vsce publish` con un publisher real (cambia `publisher` en `package.json`). Para Open VSX (que es lo que usa Cursor): `npx ovsx publish ai-skills-manager-0.2.0.vsix -p <token>`.

### Probar en Cursor

1. Instala el VSIX: paleta → **Extensions: Install from VSIX…**, o `cursor --install-extension ai-skills-manager-0.2.0.vsix`.
2. Checklist:
   - [ ] Aparece el icono **AI Skills** en la barra lateral.
   - [ ] La matriz muestra `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills` y `~/.codex/skills` como leídas por Cursor.
   - [ ] Instala un skill en `~/.cursor/skills` y comprueba que aparece en **Cursor Settings → Rules & Skills** (o escribiendo `/` en el chat).
   - [x] Cursor 3.25.9 ofrece el proveedor de auth `github` (verificado con `test:e2e`). Sin login, la extensión sigue funcionando (límite de 60 peticiones/hora).
   - [ ] Elimina el skill y comprueba que Cursor deja de verlo.

## Limitaciones conocidas (v0.2)

- No muestra skills de plugins (Claude/Cursor), la ruta enterprise de Claude Code ni skills aportados por extensiones de VS Code.
- Cursor recorre cada carpeta de skills de forma recursiva (`skills/<grupo>/<skill>/SKILL.md`); aquí solo se lee el primer nivel.
- Solo GitHub (no GitLab ni Bitbucket). En repos gigantes el árbol puede venir truncado.
- Los modales de instalar, actualizar, copiar/mover y desinstalar no tienen test automático en el editor real (requieren clics): ver *Pendiente de prueba manual* en `docs/ANALISIS.md`.
- El proxy se verificó con `http.proxy` en VS Code 1.140 y Cursor 3.25.9 (base 1.128). En versiones antiguas de VS Code, `fetch` puede no respetarlo.
- Aún no hay habilitar/deshabilitar, ni gestión de MCP, agentes o reglas: ver el roadmap en `docs/ANALISIS.md`.

Análisis completo de mercado, producto y arquitectura: `docs/ANALISIS.md`.

## Licencia

MIT
