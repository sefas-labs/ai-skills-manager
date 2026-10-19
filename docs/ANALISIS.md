# AI Skills Manager — Análisis, producto e ingeniería

*Investigación realizada el 18 de octubre de 2026. Los datos de terceros (instalaciones, estrellas) son los que mostraban las páginas ese día y cambian con frecuencia.*

**Convención:** ✅ verificado en la fuente enlazada · ⚠️ verificado parcialmente · ❓ no verificado / hipótesis.

---

## Fase A — Investigación

### A.1 Qué existe hoy

#### Herramientas de línea de comandos

| Herramienta | Qué hace | Agentes | Limitaciones | Estado |
|---|---|---|---|---|
| [`gh skill`](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/) (GitHub CLI ≥ 2.90) ✅ | `install`, `search`, `preview`, `update`, `publish`. Fija versiones por tag/commit, detecta cambios por **tree SHA**, escribe la procedencia en el frontmatter del SKILL.md, valida contra la spec de agentskills.io. | Copilot (por defecto), Claude Code, Cursor, Codex, Gemini CLI, Antigravity | Solo CLI. No muestra visibilidad cruzada ni conflictos. GitHub advierte explícitamente que **no verifica** los skills. | Preview pública, mantenido por GitHub |
| [Vercel `skills` CLI](https://cdn.jsdelivr.net/gh/vercel-labs/skills@main/README.md) (`npx skills`) ✅ | `add`, `list`, `remove`, `update`, `find`. Por defecto crea **symlinks** desde una copia canónica a cada agente. | ~79 según su README | Solo CLI; las rutas que usa por agente no siempre coinciden con la doc oficial del agente (p. ej. Cursor global `~/.cursor/skills`). | Activo |
| [Agent Skills CLI](https://github.com/Karanjot786/agent-skills-cli) ✅ | Marketplace, lockfile (`~/.skills/skills.lock`), `skills doctor --deep` (conflictos), diffs, scoring. | 42–45 (el README se contradice) | Solo CLI; sin escaneo de seguridad documentado. | 174★, MIT |

#### Funciones nativas de los editores

| Producto | Qué ofrece | Limitaciones |
|---|---|---|
| [VS Code — Agent Customizations editor](https://code.visualstudio.com/docs/agent-customization/agent-skills) ✅ | Pestaña **Skills** (crear, gestionar), `/skills` en el chat, marketplace experimental (`chat.customizations.marketplace.enabled`) que instala desde un feed de GitHub. Lee `.github/skills`, `.claude/skills`, `.agents/skills` y sus equivalentes en `~`. | Centrado en Copilot. No muestra qué otros agentes ven cada skill. Marketplace experimental. |
| [Cursor — Customize](https://cursor.com/docs/skills) ✅ | Lista skills; instala **plugins** desde un repo de GitHub que tenga `.cursor-plugin/marketplace.json`. | Según su doc, los skills sueltos **no** se pueden importar: hay que empaquetarlos como plugin. |
| Claude Code ✅ | `/plugin` para plugins; skills en `~/.claude/skills` y `.claude/skills`; `skillOverrides` para desactivar. | Sin UI de gestión de skills sueltos; solo Claude. |

#### Extensiones de VS Code / Open VSX

| Extensión | Funciones (según su página) | Agentes | GitHub URL | Señales | Hueco que deja |
|---|---|---|---|---|---|
| [Claude Code Manager](https://github.com/vishalguptax/claude-code-manager) ✅ | Sesiones, uso, MCP, skills, hooks, agentes, plugins | Solo Claude | No documentado | 28★, Apache-2.0 | Mono-proveedor |
| [Claude Code ToolBox](https://marketplace.visualstudio.com/items?itemName=AmitChorasiya.cloude-code-toolbox-vscode) ✅ | Hub de MCP y skills, puentes Cursor→Claude, muchas funciones extra | Claude (lee MCP de Cursor/VS Code) | Vía `npx skills add` | 5.491 instalaciones | Muy amplio, centrado en Claude; depende de `npx` |
| [Claude Manager Pro](https://marketplace.visualstudio.com/items?itemName=ricardo-de-los-santos.claude-skills-manager) ✅ | Skills, plugins, agentes, comandos, MCP, "security audit" ❓ | Claude + DeepSeek | Sí: **clona** el repo y **genera un SKILL.md** si falta | 206 instalaciones | Instala cualquier repo como skill, justo lo que no debe hacerse |
| [Agent Skill Ninja](https://github.com/aktsmm/vscode-agent-skill-ninja) ✅ | Buscar, instalar, previsualizar, herramientas para el agente | Copilot, Claude, Cursor, Windsurf, Cline | Sí (repo o carpeta) | 25★; licencia **CC BY-NC-SA** (no comercial) | Sin visibilidad cruzada; sin Codex como destino |
| [Skills.sh](https://github.com/amak07/vscode-skills-sh) ✅ | Navegar skills.sh, instalar, detectar actualizaciones (Trees API), `skills.json` | 11 | No; usa `npx skills add` | 6★ | Requiere Node + CLI externa |
| [Agent Skills (laurids)](https://open-vsx.org/extension/laurids/agent-skills-sh) ⚠️ | "Browse, install, and manage" | Cursor, Claude Code, Codex… | ❓ | 4.702 descargas en Open VSX, v0.1.16 (mar 2026) | No inspeccionado a fondo |
| [Agent Skills Manager Pro](https://marketplace.visualstudio.com/items?itemName=yidayoung.agent-skills-manager-pro) ✅ | Marketplaces (skills.sh, skillsmp), instalar/actualizar/eliminar | Claude, Cursor, Cline (ejemplos) | "Install from URL" ❓ | 148 instalaciones | — |
| [Open Skills Manager](https://marketplace.visualstudio.com/items?itemName=rtaparay.Open-Skills-Manager) ✅ | Repos de skills por URL de GitHub, búsqueda en ~58k skills | 7 forks de VS Code (no agentes) | Sí | 316 instalaciones | Organiza por editor, no por agente |
| MCP Manager for Claude Code, AgentSkillsManager, Skills.sh Manager | Aparecen en búsquedas | — | — | — | ❓ no inspeccionadas |

### A.2 Comparativa: lo que nadie cubre bien

| Necesidad | CLIs (`gh skill`, `npx skills`) | Editor nativo | Extensiones existentes |
|---|---|---|---|
| Instalar desde GitHub | ✅ resuelto | ⚠️ parcial / experimental | ✅ varias |
| **Qué agente carga realmente cada skill** (por carpeta, según doc oficial) | ❌ | ❌ (cada editor solo ve lo suyo) | ❌ no encontrado |
| **Duplicados / sombreado** del mismo nombre entre carpetas, por agente | ⚠️ `doctor --deep` (Agent Skills CLI) | ❌ | ❌ no encontrado |
| Validación contra la spec (name = carpeta, longitudes, frontmatter) en el inventario | ⚠️ solo al publicar (`gh skill publish`) | ❌ | ❌ no encontrado |
| Inspección de seguridad **antes** de instalar (unicode oculto, `curl \| sh`, overrides de prompt) | ⚠️ `gh skill preview` (manual) | ❌ | ❓ "security audit" sin detalles |
| Desinstalar respetando symlinks (no borrar la copia canónica) | ⚠️ implícito en `npx skills` | — | ❓ no documentado |

### A.3 Veredicto

**Un "gestor de skills" genérico no vale la pena.** La instalación desde GitHub está resuelta por `gh skill` (con respaldo de GitHub) y por más de ocho extensiones; además, VS Code y Cursor están incorporando gestión nativa, así que ese hueco se cierra solo.

**Sí hay una oportunidad pequeña y concreta:** ninguna herramienta responde *"¿qué ve cada agente y está bien configurado?"*. Desde 2026 los agentes leen carpetas solapadas (Cursor lee `.claude`, `.codex`, `.agents` y `.cursor`; Codex solo `.agents`; Copilot `.github`, `.claude` y `.agents`), y esa es la fragmentación que el usuario sufre de verdad: duplicados invisibles, skills que un agente ignora y nombres que no cumplen la spec.

**Recomendación:** construir el MVP **acotado a visibilidad + diagnóstico + instalación segura**, sin competir en catálogo. Hay que tratarlo como herramienta personal o proyecto de portafolio hasta validar la demanda: publicarlo en Open VSX/Marketplace y medir. Las cifras de la competencia (cientos o pocos miles de instalaciones) indican una demanda real pero fragmentada, no un mercado grande.

**Riesgo principal:** VS Code o Cursor añaden una vista multi-agente nativa. Mitigación: mantener el núcleo independiente del editor (ya lo es) para poder reutilizarlo como CLI.

---

## Fase B — Producto

### B.1 Propuesta de valor

> *"Mira en un solo lugar qué skills ve cada agente de IA (Claude Code, Cursor, Codex, Copilot), detecta duplicados y skills rotos, e instala desde GitHub sabiendo exactamente qué entra y quién lo va a usar."*

### B.2 Usuarios objetivo

1. **Desarrollador que usa 2 o más agentes** (p. ej. Cursor + Claude Code CLI) y acumula skills en varias carpetas.
2. **Tech lead** que versiona skills en el repo (`.agents/skills`, `.claude/skills`) y quiere ver qué ve cada miembro del equipo según su herramienta.
3. **Persona preocupada por la seguridad** que quiere revisar un skill de terceros antes de instalarlo.

No objetivo (por ahora): quien usa un solo agente y está contento con su UI nativa.

### B.3 MVP (v0.1, implementado)

| Requisito del MVP | Estado |
|---|---|
| Detectar skills instalados (4 proveedores + carpetas extra configurables) | ✅ |
| Visualizar en dashboard (Webview) y panel lateral (TreeView) | ✅ |
| Distinguir global / workspace / admin | ✅ |
| Instalar desde URL de GitHub (repo, carpeta, `blob/.../SKILL.md`, `owner/repo`) | ✅ (probado contra GitHub simulado y contra `anthropics/skills` real, 18-oct-2026) |
| Desinstalar con seguridad (backup recuperable; symlinks: solo el enlace) | ✅ |
| Abrir ubicación y revisar archivos | ✅ |
| Funcionar en VS Code / evaluar Cursor | ✅ e2e en VS Code 1.140 y Cursor 3.25.9; ⚠️ falta recorrer los modales a mano (ver C.8) |

Extras que entraron por ser baratos y diferenciales: matriz de visibilidad, duplicados por agente, validación de la spec, inspección de seguridad, procedencia (repo + commit + tree SHA), Workspace Trust.

### B.4 Boceto del dashboard (implementado)

- **Cabecera:** nombre, número de skills, hora del último escaneo, pestañas *Overview · Skills · Install from GitHub* y botón de refrescar.
- **Overview:**
  - 5 tarjetas: skills, en workspace, globales, con problemas (clic → filtro) y nombres duplicados.
  - **Matriz "Which agent loads which folder"**: filas = carpetas, columnas = agentes, ● = el agente lee esa carpeta (según su doc), y número de skills por carpeta. Es el núcleo del producto.
  - Tarjetas por agente: skills visibles, duplicados, cómo desactivar en ese agente y enlace a su doc.
  - "Needs attention": lista de problemas.
- **Skills:** buscador y filtros (agente, alcance, estado), lista con chips de alcance y píldoras por agente (tachado = no lo carga). El detalle muestra acciones (Open, Reveal, Copy path, Remove), visibilidad, ubicación o destino del symlink, procedencia, checks, frontmatter, archivos clicables y el cuerpo del SKILL.md.
- **Install from GitHub:** tres pasos.
  1. URL → *Analyze*.
  2. Candidatos con checkbox, problemas de la spec, hallazgos preliminares y vista previa.
  3. Descarga a staging + revisión completa, selector de destino que muestra **qué agentes lo verán**, y confirmación modal nativa.

Capturas: [overview](images/overview-dark.png), [skills](images/skills-dark.png), [instalación](images/install-light.png).

### B.5 Diferenciación

| | Este proyecto | `gh skill` | Extensiones existentes |
|---|---|---|---|
| Unidad de organización | **Carpeta → agentes que la leen** | Agente destino | Agente o editor destino |
| Duplicados por agente | ✅ | ❌ | ❌ |
| Validación de la spec en el inventario | ✅ | Al publicar | ❌ |
| Revisión de seguridad automática antes de instalar | ✅ heurística, con un segundo modal si hay riesgo alto | Preview manual | ❓ |
| Rechaza repos que no son skills | ✅ con pista (plugin / MCP / casing) | ✅ | ⚠️ alguna genera SKILL.md |
| Dependencias en runtime | 0 | `gh` | Algunas requieren `npx` |

---

## Fase C — Ingeniería

### C.1 Arquitectura

```
┌───────────────────────────── VS Code / Cursor (extension host) ─────────────────────────────┐
│  extension.ts ── comandos, TreeView, badge                                                   │
│        │                                                                                      │
│  ui/service.ts (SkillsService) ── escaneo, watchers, Workspace Trust, settings, lock         │
│  ui/tree.ts (TreeDataProvider)    ui/dashboard.ts (Webview host + flujo de instalación)      │
│  ui/actions.ts ── abrir / revelar / copiar / desinstalar con modal, GitHub auth (opcional)   │
│        │                         ▲ postMessage (JSON, sin secretos) ▼                         │
│        │                  webview/main.ts (TS + DOM, CSP con nonce, solo textContent)        │
├────────┼──────────────────────────────────────────────────────────────────────────────────────┤
│  core/  (sin dependencia de `vscode`; se prueba en Node puro)                                 │
│   providers/   Provider Adapters: carpetas que cada agente lee según su doc                  │
│   discovery    Discovery Engine: fusiona carpetas, escanea, symlinks, visibilidad, conflictos│
│   frontmatter  parser YAML acotado (sin dependencias)                                        │
│   validate     Security & Validation (spec agentskills.io)                                   │
│   github       cliente REST (API + raw), parseo de URLs, token solo a hosts de GitHub        │
│   inspector    Security & Validation: heurísticas de contenido                               │
│   installer    Installation Manager: inspect → stage → plan → commit (+backup/rollback)      │
│                y desinstalación                                                              │
│   lockfile     procedencia de lo instalado aquí                                              │
│   provenance   procedencia del lock o de los metadatos de `gh skill`                          │
│   updates      Update Manager: check por tree SHA, diff por blob SHA, prepare → commit       │
│   transfer     copiar/mover entre carpetas (staging + backup + lock)                         │
│   monorepo     raíz del repo, carpetas padre y anidadas                                       │
│   paths        safeJoin, validación de rutas, nombres válidos                                │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

Correspondencia con los 8 módulos pedidos:

| Módulo | Dónde | Estado |
|---|---|---|
| 1. Discovery Engine | `core/discovery.ts` | ✅ |
| 2. Provider Adapters | `core/providers/index.ts` | ✅ (4 + carpetas extra por configuración) |
| 3. Installation Manager | `core/installer.ts` | ✅ |
| 4. Update Manager | `core/updates.ts`, `core/provenance.ts`, `ui/updates.ts` | ✅ v0.2 (tree SHA remoto, diff por blob SHA, procedencia de `gh skill`) |
| 5. Configuration Manager | `ui/service.ts` (settings de la extensión) | ⚠️ solo settings propios; editar configs de agentes es v0.3+ |
| 6. Registry / Marketplace | — | 🔜 en curso (catálogo en Install) |
| 7. Dashboard UI | `ui/dashboard.ts`, `webview/main.ts`, `media/dashboard.css` | ✅ |
| 8. Security & Validation | `core/validate.ts`, `core/inspector.ts`, `core/paths.ts` | ✅ |

**Decisiones técnicas:**

- **TypeScript + esbuild.** Todo el código es TS estricto; esbuild genera `dist/extension.js` (CJS) y `dist/webview.js` (IIFE).
- **Webview en TS sin framework (no React + Vite en v0.1).** Son 3 vistas y unas 700 líneas; React añadiría ~45 KB, otra cadena de build y más superficie de CSP sin un beneficio claro. Además, `@vscode/webview-ui-toolkit` fue deprecado en enero de 2025. **Pasar a React + Vite cuando** llegue el marketplace (listas virtualizadas, rutas, estado complejo). Lo que facilita la migración: el protocolo de mensajes ya está tipado en `src/shared/protocol.ts`.
- **GitHub REST, no `git clone`.** No requiere git instalado, nunca ejecuta hooks, permite descargar solo las carpetas elegidas y obtener el tree SHA para detectar actualizaciones.
- **Cero dependencias en runtime.** Menos superficie de cadena de suministro; el VSIX pesa ~40 KB.

### C.2 Estructura de carpetas

```
skills-manager/
├── package.json            manifiesto de la extensión (contributes, settings, scripts)
├── src/
│   ├── extension.ts        activación y comandos
│   ├── core/               motor sin vscode (testeable en Node)
│   │   ├── types.ts  frontmatter.ts  validate.ts  paths.ts
│   │   ├── discovery.ts  lockfile.ts  github.ts  inspector.ts  installer.ts
│   │   ├── provenance.ts  updates.ts  transfer.ts  monorepo.ts
│   │   └── providers/index.ts
│   ├── shared/protocol.ts  mensajes host ↔ webview
│   ├── ui/                 service, tree, dashboard, actions, updates, transfer
│   └── webview/main.ts     UI del dashboard
├── media/                  dashboard.css, icon.svg, icon.png
├── test/
│   ├── unit/               frontmatter, paths, validate/github/inspector, discovery
│   ├── integration/        instalación, actualizaciones y copiar/mover contra GitHub simulado (SHAs como git)
│   ├── smoke/              carga dist/extension.js con un `vscode` simulado
│   ├── e2e/                ejecuta la extensión en VS Code / Cursor reales (perfil temporal, proxy local)
│   └── helpers/
├── scripts/                build.mjs, package-vsix.mjs, run-tests.mjs
├── typings/sandbox/        subconjunto de tipos de vscode (solo para entornos sin npm)
└── docs/                   este documento + capturas
```

### C.3 Modelos de datos

Definidos en `src/core/types.ts`:

- **`ReadLocation`**: lo que declara un adaptador (`path`, `scope`, `readOnly`, `managedSubdirs`).
- **`ResolvedLocation`**: carpeta fusionada, con `readers: ProviderId[]` (qué agentes la leen), `exists`, `skillCount` e `ignoredEntries`.
- **`SkillRecord`**:
  - identidad: `name`, `dirName`;
  - ubicación: `dir` y `realDir`, más `isSymlink`;
  - `visibleTo`, `frontmatter`, `issues[]`, `readOnly`;
  - procedencia: `source` (del lock) y `sourceHint` (del frontmatter, p. ej. lo que escribe `gh skill`).
- **`LockEntry`**: `{ name, dir, locationPath, source: { owner, repo, ref, commit, subpath, treeSha, url }, installedAt, contentHash, fileCount }`. Se guarda en el *global storage* de la extensión y **no** modifica el SKILL.md instalado.
- Instalación (`installer.ts`):
  - `RepoInspection`: contiene los `Candidate`;
  - `Candidate`: archivos, omitidos, problemas, hallazgos e instalable o no;
  - `StagedSkill` → `InstallPlan` → `InstallResult`.

### C.4 Interfaz de adaptadores

```ts
interface ProviderAdapter {
  id: string;                    // 'cursor'
  displayName: string;           // 'Cursor'
  docsUrl: string;               // doc oficial contra la que se validaron las rutas
  readLocations(ctx: DiscoveryContext): ReadLocation[];  // solo comportamiento documentado
  disableHint?: string;          // cómo se desactiva un skill en ese agente
}
```

Para añadir un proveedor basta un objeto nuevo en `providers/index.ts`; discovery, conflictos, matriz y UI no cambian. Sin tocar código, `skillsManager.extraLocations` permite declarar carpetas y lectores arbitrarios (p. ej. Windsurf).

**Rutas validadas (18-oct-2026):**

| Carpeta | Claude Code | Cursor | Codex | Copilot (VS Code) |
|---|:-:|:-:|:-:|:-:|
| `<ws>/.claude/skills` | ✅ | ✅ | | ✅ |
| `<ws>/.agents/skills` | | ✅ | ✅ | ✅ |
| `<ws>/.cursor/skills` | | ✅ | | |
| `<ws>/.codex/skills` | | ✅ | | |
| `<ws>/.github/skills` | | | | ✅ |
| `~/.claude/skills` | ✅ | ✅ | | ✅ |
| `~/.agents/skills` | | ✅ | ✅ | ✅ |
| `~/.cursor/skills` | | ✅ | | |
| `~/.codex/skills` | | ✅ | | |
| `~/.copilot/skills` | | | | ✅ |
| `/etc/codex/skills` (admin, solo lectura) | | | ✅ | |
| `~/.claude/skills/synced/<cuenta>/*` (claude.ai, solo lectura) | ✅ | ⚠️ ❓ | | ⚠️ ❓ |
| **Monorepo:** `.claude/skills` en carpetas padre hasta la raíz del repo | ✅ | ❓ no documentado | | ⚠️ solo la raíz, con `chat.useCustomizationsInParentRepositories` |
| **Monorepo:** `.agents/skills` en carpetas padre hasta la raíz del repo | | ❓ no documentado | ✅ | ⚠️ ídem |
| **Monorepo:** `<sub>/.claude/skills` anidado (se carga al trabajar en `<sub>`) | ✅ con namespace `/<sub>:name` | | | ❓ |
| **Monorepo:** `<sub>/.cursor/skills`, `<sub>/.agents/skills` anidados | | ✅ "anywhere inside your repository" | ❓ no documentado | ❓ |

Notas del 18-oct-2026:
- **Synced:** la doc de Claude Code dice `~/.claude/skills/synced/`. En disco (Claude Code 2.1.27x), cada skill está un nivel más abajo, en un bucket por cuenta u organización: `synced/<org>_<cuenta>/<skill>/SKILL.md`, junto a un `manifest.json`. Se aceptan ambos niveles. ⚠️ El nombre del bucket es `<oauthAccount.organizationUuid>_<oauthAccount.accountUuid>` de `~/.claude.json`, observado en esta máquina el 18-oct-2026: el bucket de la cuenta activa se actualizó el 14-oct y el de otra cuenta lleva parado desde el 20-sep. La doc dice que se descarga *"your account's skills"*, así que solo se listan los skills de la cuenta activa y el resto se cuenta como omitido. Que Claude Code ignore los otros buckets está deducido, no documentado. Si se desactiva la sincronización, Claude Code mueve los skills a `~/.claude/skills/.trash/`; como empieza por punto, se ignora.
- **Codex:** la URL `developers.openai.com/codex/skills` redirige ahora a `learn.chatgpt.com/docs/build-skills`. Los skills de sistema viven en `~/.codex/skills/.system/`. Cursor lee `~/.codex/skills`, pero no está documentado si también lee `.system` (❓); por ahora se ignora.
- **Cursor** "walks the skills root recursively" (`skills/<grupo>/<skill>/SKILL.md`). Aquí todavía se lee solo el primer nivel (⚠️, ver roadmap).
- La carpeta de workspace del editor hace de "directorio de inicio" / `$CWD`. La raíz del repo es la carpeta más cercana con `.git`, ya sea directorio o archivo; en un worktree enlazado, la búsqueda se detiene en su raíz, como documenta Claude Code.

**Procedencia escrita por `gh skill install` (✅ verificado con gh 2.102.0, instalando `anthropics/skills pdf` y `docx --pin`):**

```yaml
metadata:
    github-path: skills/pdf
    github-pinned: <sha>            # solo con --pin
    github-ref: refs/heads/main     # o el SHA si está fijado
    github-repo: https://github.com/anthropics/skills
    github-tree-sha: 6369f4649de69bd6857c9bc3b058a77206009238
```

`gh` reescribe el frontmatter: ordena las claves y sangra con 4 espacios. No guarda el commit. Además, escribe `~/.agents/.skill-lock.json` (versión 3) indexado **solo por nombre** de skill, lo que lo hace ambiguo entre agentes. Por eso se usa el frontmatter, que es por skill.

Fuentes: [Claude Code](https://code.claude.com/docs/en/skills) · [Cursor](https://cursor.com/docs/skills) · [Codex](https://developers.openai.com/codex/skills) · [VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) · [Spec](https://agentskills.io/specification).

**Qué se puede compartir y qué no:**

- El formato SKILL.md (`name` + `description`) es común a todos.
- Campos como `allowed-tools`, `paths`, `disable-model-invocation` o `context` varían por agente. Fuera de Claude Code, `package_skill.py` y la API solo aceptan `name`, `description`, `license`, `compatibility`, `metadata` y `allowed-tools`.
- Para máxima portabilidad conviene usar `.agents/skills` (Cursor, Codex, Copilot) o `.claude/skills` (Claude Code, Cursor, Copilot). **Ninguna carpeta llega a los cuatro agentes**, y por eso la matriz es útil.

### C.5 Flujos

**Detección**

1. Se resuelve el contexto: `home`, carpetas `file://` del workspace y plataforma.
2. Los adaptadores declaran sus carpetas, que se fusionan por ruta. La clave de comparación no distingue mayúsculas en macOS/Windows.
3. Para cada carpeta existente se ejecuta `readdir` y, por cada entrada, `lstat`:
   - **symlink**: se resuelve con `realpath`; si el destino no existe se marca como roto;
   - **SKILL.md con el casing exacto** (comprobado con `readdir`, no con `existsSync`): se lee hasta 1 MB → frontmatter → validación;
   - subcarpetas gestionadas por terceros (`synced/`): se marcan como solo lectura.
4. `visibleTo` = lectores de la carpeta.
5. Por agente se agrupa por `name`. Si hay 2 o más carpetas reales distintas se emite un aviso de duplicado; si son la misma carpeta real (symlinks) solo un aviso informativo.
6. Se refresca con watchers de cada carpeta existente, el patrón del workspace, el foco de ventana y los cambios de settings o de trust.

**Instalación**

1. `parseGitHubUrl`: solo github.com. Si la ref contiene `/`, se prueban divisiones ref/path de la más corta a la más larga contra la API.
2. `inspectRepository`:
   - resuelve el commit y obtiene el árbol recursivo;
   - busca carpetas con `SKILL.md`, quedándose con las más externas e ignorando `node_modules` y `.git`;
   - si no hay ninguna, error con una pista (plugin, MCP o casing);
   - descarga **solo** los SKILL.md, valida y calcula los hallazgos preliminares.
3. El usuario elige → `stageCandidates` descarga **al commit exacto** en un staging privado:
   - `safeJoin` en cada ruta;
   - escritura con `flag: 'wx'` y `mode: 0o644`, sin bits de ejecución;
   - límites de tamaño;
   - omite symlinks y submódulos;
   - inspecciona el contenido completo.
4. El usuario elige el destino (la UI muestra qué agentes lo verán) → `planInstall` detecta conflictos.
5. Si hay hallazgos `high` → modal adicional "I reviewed them". Después, modal nativo con resumen: origen@commit, destino, visibilidad y reemplazos.
6. `commitInstall`:
   - el existente se mueve a `backups/` (un symlink se guarda como `.symlink.txt`);
   - `rename` staging → destino (con fallback copy+rm si EXDEV);
   - se escribe el lock;
   - **ante cualquier error, rollback** (verificado en tests).

**Actualización**

1. *Check for Updates*: se juntan los skills con procedencia (lock o `gh skill`) por `owner/repo@ref`. Cada grupo cuesta `GET /commits/{ref}` (commit y tree raíz) más un `GET /git/trees/{commit}?recursive=1`. Si el árbol viene truncado, se recorre nivel a nivel. Los skills fijados a un commit no consumen llamadas.
2. Hay *update available* si el tree SHA de la subcarpeta difiere del guardado. El resultado se guarda en `globalState` con una `basis` (versión instalada); si esta cambia, la caché se invalida.
3. *Update…* → `prepareUpdate`:
   - descarga la versión nueva a staging con las mismas reglas que una instalación;
   - lista los archivos de la versión instalada con `GET /git/trees/{treeSha}`;
   - compara blob SHAs de git: instalada → nueva (diff del upstream) e instalada → local (cambios locales). No hace falta descargar la versión instalada.
   - En skills de `gh`, el SKILL.md local no cuenta como cambio local, porque `gh` le añade metadatos.
4. Modales:
   - un segundo modal si hay hallazgos `high`;
   - el resumen (commits, diff, cambios locales que se perderán, visibilidad), con *Compare Files…* (`vscode.diff`).
   Al confirmar: `planInstall` → `commitInstall` con backup y rollback. El lock pasa al commit nuevo.

**Copiar / mover**

1. Elección del destino (muestra quién lo lee) y del modo. Mover no está disponible para symlinks, skills de solo lectura o sincronizados.
2. `planTransfer` calcula:
   - los agentes que lo ganan y lo pierden;
   - los nombres que quedarían duplicados en el destino;
   - los archivos ejecutables, que perderán `+x`, y los omitidos (symlinks internos, nombres inválidos).
3. `executeTransfer`:
   - escribe en staging con `safeJoin` + `wx` + `0o644`;
   - `placeStaged` hace backup y rollback;
   - el lock se copia al destino;
   - al mover, el original va a `backups/`.

**Desinstalación**

1. Modal que explica el efecto exacto y qué agentes lo pierden.
2. Antes de actuar se vuelve a ejecutar `lstat`.
3. Si es symlink → `unlink` (el destino no se toca); si es carpeta → se mueve a `backups/` (recuperable).
4. Se rechaza si la carpeta es de solo lectura o no está directamente dentro de una ubicación conocida.

### C.6 Sistemas operativos y editores

| Tema | Solución |
|---|---|
| Rutas y separadores | `path.join/resolve`; las rutas del repo (POSIX) se validan antes de unirlas |
| Nombres inválidos en Windows (`CON`, `aux`, `:`, punto o espacio final) | Se rechazan en `validateRelativePath` aunque el SO actual sea Unix, para que un repo instalado en macOS no rompa a un compañero en Windows |
| FS sin distinción de mayúsculas (macOS/Windows) | Claves de ruta en minúsculas; detección de `skill.md` mal escrito con `readdir` |
| `/etc/codex/skills` | Solo en no-Windows; solo lectura |
| Symlinks en Windows | Se leen; la extensión nunca los crea (salvo al restaurar un backup) |
| `EXDEV` (staging en otro volumen) | Fallback copy+rm |
| Remote SSH / WSL / Codespaces | `extensionKind: workspace`: escanea el `~` **remoto**. Workspaces virtuales no soportados (`virtualWorkspaces: false`) |
| Cursor | Usa la misma API de extensiones. Distribución vía **Open VSX** o VSIX. ✅ Cursor 3.25.9 (base 1.128) incluye `vscode.github-authentication`; `getSession` responde sin errores (verificado con `test:e2e`) |
| Proxy corporativo | ✅ Con `http.proxy` apuntando a un proxy CONNECT local, `fetch` y `https` van por el proxy en VS Code 1.140 y Cursor 3.25.9 (`http.fetchAdditionalSupport` = `true`). ❓ En versiones de VS Code que no tengan ese ajuste no está verificado. No se probó un proxy con autenticación ni con inspección TLS |

### C.7 Riesgos técnicos y de seguridad

| Riesgo | Mitigación implementada | Riesgo residual |
|---|---|---|
| Skill malicioso (prompt injection, scripts) | Inspección heurística + confirmación doble si hay riesgo alto; nunca ejecuta nada; archivos sin `+x` | **Las heurísticas no garantizan nada.** Un agente puede ejecutar los scripts más tarde. La decisión final es del usuario y la UI lo dice |
| Path traversal / rutas absolutas desde el árbol de GitHub | `validateRelativePath` + `safeJoin` + `isPathInside`; tests | — |
| Symlinks en el repo apuntando fuera | No se crean (se listan como omitidos) | — |
| Symlink local en el destino | `realpath` de la ubicación; al reemplazar un symlink se guarda su destino y no se sigue | — |
| Sobrescritura sin consentimiento | `planInstall` detecta, `commitInstall` exige `overwrite` y la UI lo pide en un modal | — |
| Fallo a mitad de instalación | Backup → move → rollback; staging aislado | Si el proceso muere entre backup y move, el original queda en `backups/` (recuperable a mano) |
| Token de GitHub | Solo de la sesión del editor; solo en memoria; solo se envía a `api.github.com` y `raw.githubusercontent.com` (test); nunca cruza al webview | — |
| Webview | CSP sin `unsafe-inline`/`unsafe-eval`, script con nonce, contenido solo vía `textContent` | — |
| Workspace no confiable | Las carpetas del workspace pasan a solo lectura; no se instala ni se borra ahí | — |
| TOCTOU entre escaneo y acción | Se vuelve a ejecutar `lstat` y a validar al desinstalar e instalar | Ventana mínima |
| Rate limit (60/h sin login) | Mensaje accionable + login opcional | Repos con cientos de skills pueden agotar el límite sin login |
| Una actualización pisa ediciones locales | Diff local por blob SHA antes de actualizar; el botón dice *Replace Local Edits and Update*; backup previo | Si la versión instalada ya no existe en GitHub (force-push + GC), los cambios locales salen como "desconocidos" |
| Metadatos de `gh skill` manipulados en un SKILL.md | Solo se aceptan URLs `https://github.com/<o>/<r>`, `github-path` validado con `validateRelativePath`, refs sin `..` ni caracteres raros, SHAs de 40 hex | Un SKILL.md puede apuntar a otro repo de GitHub: la actualización lo muestra (repo, ref y diff) y pide confirmación |
| Copiar/mover pierde permisos `+x` de scripts locales | Se avisa en el modal (lista de archivos) | Es intencionado: regla `0o644` |
| Escaneo de carpetas anidadas en workspaces grandes | Profundidad máx. 6, 5.000 carpetas, omite ocultas, `node_modules` y carpetas de build, sin seguir symlinks; desactivable | Monorepos más profundos pueden quedar sin cubrir |
| Rutas de los agentes cambian | Adaptadores con `docsUrl` y fecha de verificación; `extraLocations` como escape | Mantenimiento continuo |

### C.9 Añadido en 0.3 (tras usar la extensión en real)

Estas funciones salieron de usar la extensión a diario (18–19 oct 2026):

| Función | Dónde | Cómo funciona | Verificado |
|---|---|---|---|
| Detección de agentes y del editor | `core/agents.ts` | Solo mira archivos, sin ejecutar nada: binario en el PATH, app (`/Applications/Cursor.app`), `~/.claude.json`, `~/.codex/config.toml` o `auth.json`, `~/.copilot`, y extensiones (`anthropic.claude-code`, `openai.chatgpt`, `github.copilot(-chat)`). El editor se identifica por `vscode.env.appName`: Cursor → `cursor`; VS Code → `copilot` (VS Code 1.140 incluye `GitHub.copilot-chat`). | ✅ en esta máquina y con e2e en VS Code 1.140/1.142 y Cursor 3.25.9 |
| Cuentas de claude.ai | `core/discovery.ts` | Hay un bucket por cuenta: `synced/<org>_<cuenta>`. Solo se lista el de `oauthAccount.organizationUuid/accountUuid` de `~/.claude.json`; los demás se cuentan como omitidos y se explican en la UI. | ⚠️ formato observado, no documentado |
| Copias idénticas | `core/hashing.ts`, discovery | Si varias copias con el mismo nombre tienen la misma huella de contenido (blob SHA de git por archivo), es información, no conflicto. | ✅ tests |
| Arreglos automáticos | `core/fixes.ts`, `ui/fixes.ts` | `name` = carpeta o renombrar la carpeta; añadir `name`, `description` o frontmatter; `skill.md` → `SKILL.md`; quitar un symlink roto. Las ediciones de SKILL.md cambian una línea, se verifican volviendo a parsear, guardan un backup y se escriben con `wx` + rename. | ✅ tests de integración |
| Sugerencias de merge | `core/merge.ts`, `ui/merge.ts` | Solo dentro del mismo alcance: el conjunto mínimo de copias que sigue llegando a los agentes **instalados**. Las sobrantes van al backup; si todas son necesarias, se pueden igualar las versiones. | ✅ tests |
| Elegir qué copia se usa | `core/choose.ts`, `ui/choose.ts` | Cursor y Copilot no documentan qué copia gana ni permiten ocultar una carpeta, así que la elección se aplica igualando las demás (nadie pierde el skill) o quitándolas (avisa de quién lo pierde). | ✅ tests + smoke |
| Add to project | `ui/transfer.ts` | Copia un skill global a una carpeta del proyecto. Indica qué cargará el equipo y qué ganas tú, y avisa si la licencia es propietaria o el skill viene de claude.ai. | ✅ smoke |
| Pestaña Map | `webview/main.ts` | Cobertura skill × agente con el motivo de cada celda y un botón *Copy to*, más un diagrama SVG agente → carpeta → skill, sin librerías. | ✅ jsdom + capturas |
| Coherencia host/webview | `scripts/build.mjs` | Ambos bundles comparten el id de build. Si no coinciden (se reinstaló sin recargar), el dashboard pide recargar la ventana. | ✅ jsdom |

**Lecciones del uso real:**
- Reinstalar un VSIX sin recargar la ventana deja el dashboard nuevo hablando con el host viejo. Causó dos "bugs" que no lo eran y motivó el id de build y el canal de log **AI Skills**.
- Los e2e arrancan un editor limpio, así que no ven ese caso; los smoke y jsdom sí lo cubren.

### C.8 Estado de implementación (v0.2)

**Implementado:**
- Todo lo de B.3.
- v0.2:
  - actualizaciones (lock + `gh skill`);
  - copiar/mover;
  - monorepos (carpetas padre y anidadas);
  - lectura de los skills sincronizados de claude.ai en su estructura real.
- 57 tests unitarios y de integración, 1 smoke test y un e2e en el editor real (`npm run test:e2e`).
- Empaquetado VSIX: con `vsce` (52 KB) y sin dependencias.

**Probado en real (18-oct-2026):**
- *Núcleo contra GitHub real* (`anthropics/skills`, sin token y con token):
  - repo completo (20 candidatos, 3 llamadas a la API; las descargas van a `raw.githubusercontent.com`, que no consume rate limit), carpeta `skills/pdf` y URL `blob/…/SKILL.md`;
  - archivos sin bit de ejecución y entrada en el lock con commit y tree SHA;
  - reemplazo con backup;
  - desinstalación de una carpeta (a `backups/`) y de un symlink (el destino queda intacto);
  - refs con `/` codificadas como `%2F`, aceptadas por la API.
- *Actualizaciones contra GitHub real:* sobre skills instalados con `gh skill` 2.102.0, el tree SHA guardado por `gh` coincide con el de la API y el diff por blob SHA sale vacío. Un skill fijado (`--pin`) sale como *pinned* sin hacer llamadas.
- *VS Code 1.140 y Cursor 3.25.9* (`test:e2e`, extensión en desarrollo dentro del editor real):
  - activación y comandos registrados;
  - árbol con los skills reales de `~/.claude/skills` (2 propios y 22 sincronizados);
  - el webview del dashboard carga con la CSP y completa el handshake;
  - proveedor de auth `github` disponible;
  - proxy;
  - comprobación de actualizaciones contra GitHub real (al día y desactualizado) con el indicador en el árbol;
  - monorepo (raíz del repo y `.cursor/skills` anidado).
- *VSIX 0.2.0* instalado en Cursor y VS Code con `--install-extension`, en perfiles aislados.

**Pendiente de prueba manual** (requiere clics; no automatizable con `--extensionTestsPath` sin simular modales):
- Recorrer a mano el flujo de instalación del dashboard (pasos 2–3 y modales), *Update…* (modal y *Compare Files…*), *Copy or Move to…* y *Remove…* en ambos editores.
- Comprobar que un skill instalado en `~/.cursor/skills` aparece en **Cursor Settings → Rules & Skills** y desaparece al quitarlo.
- Revisión visual del dashboard en temas claro, oscuro y alto contraste con las nuevas píldoras (*update*) y filas (*nested*, *parent folder*).
- Proxy con autenticación o con inspección TLS corporativa.

**Parcial:**
- No se escanean los skills de **plugins** (Claude/Cursor), la ruta enterprise de Claude Code (`/etc/claude-code/.claude/skills`, etc.) ni los skills aportados por extensiones de VS Code (`chatSkills`).
- Cursor recorre cada carpeta de skills de forma recursiva; aquí solo el primer nivel.
- Duplicados entre un skill local y uno sincronizado: Claude Code los separa (`/anthropic-skills:<name>`), pero aquí se avisa igualmente si Cursor o Copilot ven ambos (❓ no se sabe si leen `synced/`).
- Árboles truncados por GitHub en repos enormes: la instalación avisa; la comprobación de actualizaciones sí recorre nivel a nivel.

**Trabajo futuro:** ver roadmap.

---

## Roadmap

Prioridad = impacto × demanda ÷ dificultad.

| Versión | Contenido | Impacto | Dificultad | Notas |
|---|---|---|---|---|
| **0.1** | MVP | — | — | ✅ Verificado en real (ver C.8). Publicar en Open VSX y Marketplace; medir |
| **0.2** | ✅ **Actualizaciones**: tree SHA guardado vs. remoto, diff de archivos y actualización con backup. Procedencia de `gh skill` | Alto | Baja | Implementado |
| 0.2 | ✅ Copiar o mover entre carpetas con vista previa de visibilidad | Alto | Baja | Implementado |
| 0.2 | ✅ Monorepos: carpetas padre y anidadas según la doc de cada agente | Medio | Media | Implementado |
| 0.2.x | Skills de plugins (solo lectura), ruta enterprise de Claude Code, recorrido recursivo de Cursor | Medio | Media | Verificar rutas exactas antes de implementar |
| 0.2.x | Notas: `gh skill update` como alternativa en el modal de actualización; leer `~/.agents/.skill-lock.json` solo como pista (es ambiguo por nombre) | Bajo | Baja | |
| **0.3** | **Habilitar/deshabilitar** por agente: Claude `skillOverrides` (settings.json), Codex `[[skills.config]] enabled=false` (config.toml). En Cursor y Copilot solo se ofrece `disable-model-invocation`, avisando de que **edita el skill**. | Medio | Media | Necesita escribir JSON/TOML con backup |
| **0.4** | **MCP (solo lectura primero)**: inventario y duplicados entre agentes, secretos **redactados**. Rutas ❓ *por verificar contra la doc oficial antes de implementar*: Claude Code `.mcp.json` / `~/.claude.json`; Cursor `.cursor/mcp.json` / `~/.cursor/mcp.json`; VS Code `.vscode/mcp.json`; Codex `~/.codex/config.toml` `[mcp_servers]`. Después: añadir, editar y eliminar con backup. Comprobación de disponibilidad solo con acción explícita (lanza procesos). | Alto | Alta | Es el área de más riesgo: los MCP ejecutan procesos |
| **0.5** | Agentes, reglas y comandos: `.claude/agents`, `.claude/commands`, `.cursor/rules`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, mostrados por separado (son entidades distintas) | Medio | Media | Rutas por verificar |
| 0.6 | Descubrimiento: búsqueda en GitHub y/o skills.sh. Migrar el webview a React + Vite en este punto | Medio | Media | Competir aquí aporta poco; integrar en vez de duplicar |
| Luego | GitLab/Bitbucket, l10n (es/en), exponer el núcleo como CLI | Bajo–medio | Media | |
