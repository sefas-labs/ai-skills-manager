# Changelog

## 0.3.0 — 2026-10-19 (sin publicar)

Incluye todo lo planificado para 0.2 (que no llegó a publicarse) y lo que se añadió después.

### Verificación en real del MVP (Paso 0)

Probado en VS Code 1.140 y Cursor 3.25.9 (base VS Code 1.128) con `npm run test:e2e`, y contra `github.com/anthropics/skills`. Detalle en `docs/ANALISIS.md` → *Verificación en real*.

Bugs corregidos:
- `npm test` y `npm run test:smoke` no ejecutaban ningún test en Node 20: los globs de `node --test` solo existen desde Node 21. Ahora `scripts/run-tests.mjs` pasa la lista de archivos explícita.
- Los skills sincronizados desde claude.ai no aparecían. En disco están en `~/.claude/skills/synced/<org>_<cuenta>/<skill>/`, un nivel más abajo de lo que se suponía. El mismo skill sincronizado en dos cuentas se marca como informativo, no como conflicto.
- Los skills instalados desde la raíz de un repo se guardaban sin tree SHA, lo que impedía detectar actualizaciones. GitHub no lo devuelve en `/git/trees/{commit}`, así que ahora se toma de `commit.tree.sha`.
- El frontmatter convertía en número los valores formados solo por dígitos aunque se perdiera precisión (un SHA `000…` pasaba a valer `0`). Ahora solo se convierte si el número es exacto.

### Nuevo

- **Actualizaciones:**
  - El comando *Check for Updates* compara el tree SHA instalado con el de la misma subcarpeta en la ref instalada. Cuesta 2 llamadas a la API por repo+ref, y nada si el skill está fijado a un commit.
  - Se muestra "update available" en el árbol y en el dashboard.
  - *Update…* descarga la nueva versión a staging y muestra el diff de archivos (añadidos, modificados y eliminados, calculado con blob SHA sin descargar la versión instalada), los cambios locales desde la instalación y la revisión de seguridad. Desde ahí, *Compare Files…* abre el diff de cada archivo. Al confirmar, reemplaza la carpeta guardando un backup.
  - El ajuste `skillsManager.checkForUpdatesOnStartup` (desactivado por defecto) comprueba al arrancar, como mucho cada 12 h, y usa la caché el resto del tiempo.
- **Procedencia de `gh skill`:** se leen `metadata.github-repo`, `github-path`, `github-ref`, `github-tree-sha` y `github-pinned` del SKILL.md (verificado con gh 2.102.0). Esos skills también pueden comprobarse y actualizarse.
- **Copiar o mover** un skill entre carpetas (*Copy or Move to…*). Antes de escribir, muestra qué agentes lo ganan y lo pierden, los nombres que quedarían duplicados y los archivos que pierden el bit de ejecución. La entrada del lock se conserva. Un original movido va al backup. Los symlinks y los skills de solo lectura se pueden copiar, pero no mover.
- **Monorepos:**
  - carpetas padre hasta la raíz del repo: `.claude/skills` para Claude Code y `.agents/skills` para Codex;
  - carpetas anidadas: `.claude/skills` para Claude Code, con namespace propio y sin conflicto por nombre; `.cursor/skills` y `.agents/skills` para Cursor;
  - para Copilot, la raíz del repo padre si `chat.useCustomizationsInParentRepositories` está activo.

  Ajustes: `skillsManager.scanParentFolders` y `skillsManager.scanNestedFolders`.
- Dashboard: la pestaña *Skills* se divide en **Project** (workspace, incluidas las carpetas padre y anidadas) y **Global** (usuario + admin), cada una con su contador, búsqueda y detalle. Las tarjetas del Overview llevan a cada pestaña.
- **Detección de agentes y del editor:**
  - El dashboard reconoce si corre en Cursor o en VS Code y destaca su agente (Cursor o Copilot) en un aviso, en la matriz y en su tarjeta.
  - Detecta qué agentes hay instalados mirando solo archivos, sin ejecutar nada: binario en el PATH, app, `~/.claude.json`, `~/.codex/config.toml` o la extensión del editor. Indica qué evidencia encontró para cada uno.
  - Por defecto oculta de la matriz, los filtros y las píldoras los agentes no detectados, con un enlace para mostrarlos todos.
  - Marca las carpetas con skills que no lee ningún agente instalado.
- **Arreglar problemas** (*Fix…* en *Checks* del dashboard, *Fix all*, o *Fix Problems…* en el árbol):
  - `name` distinto de la carpeta o con formato inválido: poner `name` = carpeta, o renombrar la carpeta (el lock la sigue).
  - Sin `name`, sin `description` o sin frontmatter: lo añade. La descripción se pide al usuario.
  - `skill.md` con mayúsculas incorrectas: lo renombra a `SKILL.md`.
  - Symlink roto: quita el enlace.

  Antes de aplicar, un modal muestra el cambio exacto. Los cambios en SKILL.md son ediciones mínimas de una línea, se verifican volviendo a parsear y guardan un backup. Nunca se tocan skills de solo lectura. Para lo que no tiene arreglo seguro, el botón ofrece *Edit SKILL.md*.
- El dashboard ya no se queda en "Scanning…" si falla al pintar: muestra el error y un botón *Retry*. También acepta el estado de una versión anterior de la extensión (al reinstalar sin recargar).
- Skills sincronizados de claude.ai: solo se listan los de la cuenta con la sesión iniciada. La cuenta sale de `oauthAccount.organizationUuid` / `accountUuid` en `~/.claude.json`, y solo se leen esos dos campos. Las carpetas de otras cuentas son restos (ya no se actualizan, y la doc dice que se sincronizan "your account's skills"), así que no se listan y se indica cuántos skills se omitieron. Si no se puede saber la cuenta, se muestra todo, como antes.
- **Sugerencias de merge** (Overview → *Merge suggestions*, o *See merge suggestion* en un aviso de duplicado). Se agrupan los skills con el mismo nombre en varias carpetas del mismo alcance; los que están en alcances distintos no se mezclan, porque quitar la copia del proyecto afectaría al equipo. Para cada grupo:
  - Se calcula el conjunto mínimo de copias que sigue llegando a los mismos agentes **instalados**.
  - *Merge: remove N copies…* mueve las sobrantes al backup.
  - Si todas son necesarias pero el contenido difiere, *Use this version* copia una versión sobre las demás, con backup.
  - *Compare* abre el diff archivo por archivo.
  - Las copias de solo lectura nunca se quitan ni se sobrescriben, y los symlinks a la misma carpeta cuentan como una sola copia.
- **Explicación de los "duplicados" de claude.ai:** la pestaña *Global* muestra un aviso desplegable con la cuenta actual y su fecha de sincronización, la otra cuenta (fecha y skills que no se cargan) y por qué los mismos nombres aparecían dos veces. El detalle de un skill afectado, como `docs`, lo menciona.
- **Add to Project…** en los skills globales (botón en el detalle y en el árbol). Copia el skill a una carpeta del proyecto, recomendando la que llega a más agentes instalados. Si el skill es propietario o está sincronizado desde claude.ai, avisa antes de copiarlo a un repo compartido.
- Corregido: al hacer clic en un skill, la lista ya no vuelve arriba. Los re-renders conservan la posición de scroll de la lista, del detalle y de la página; el detalle vuelve arriba solo al cambiar de skill.
- **Pestaña Map** (por proyecto o global):
  - **Cobertura skill × agente**, solo con los agentes instalados. Cada celda indica ✓, ✕ o 2× y explica el motivo al pasar el ratón. El botón *Copy to <carpeta>* copia el skill a la carpeta que cierra el hueco (con confirmación y backup). Los skills sincronizados de claude.ai van agrupados y sin ese botón, porque una copia nunca se actualizaría.
  - **Diagrama agente → carpeta → skill** en SVG propio, sin librerías. Usa los colores del tema de VS Code, resalta los caminos al pasar el ratón o con el foco del teclado, y al hacer clic en un skill se abre su detalle. Marca los nombres duplicados y los skills que ningún agente instalado usa.
- *Add to project…* más claro:
  - El botón ya no se desactiva en silencio: si no hay carpeta abierta o el workspace no es de confianza, lo explica (con acceso a *Manage Workspace Trust*).
  - Cada destino indica qué agentes lo cargarán para el equipo y qué ganas tú en esta máquina. Se recomienda primero el que añade agentes nuevos.
  - Al terminar aparece *"Added … to …"* con *Show*.
  - Canal de Output **AI Skills** con cada paso, el motivo si se detiene y los errores.
- Cada build lleva un id que comparten la extensión y el dashboard. Si no coinciden (se reinstaló sin recargar la ventana), el dashboard muestra *"The extension was updated — Reload Window"*. Las acciones que la extensión no reconoce ahora muestran un error en lugar de ignorarse.
- **Elegir qué copia se usa** cuando un skill está en varias carpetas: sección *Copies* en el detalle, *Use this copy…* en el aviso de duplicado y en el árbol. Cursor y Copilot no documentan cuál eligen ni permiten ocultar una carpeta, así que la elección se aplica de una de dos formas:
  - *Igualar las demás copias* a la elegida (recomendado): nadie pierde el skill.
  - *Quitar las demás* (al backup): avisa antes de qué agentes lo pierden.

  Las copias de solo lectura, los symlinks y las carpetas con otro nombre no se tocan.
- Las copias con el mismo contenido ya no cuentan como conflicto: se muestran como información (*identical copies*).
- **Rediseño visual del dashboard:**
  - Iconos nativos de VS Code (Codicons). La fuente va en el VSIX como asset; no añade código en runtime.
  - Un color por agente en todas las vistas: lista, matriz, tarjetas, detalle y Map.
  - Lista con puntos de color e indicador *n/m* en lugar de cuatro píldoras tachadas, sin el chip de alcance redundante. Los duplicados se agrupan en una fila desplegable (*deploy · 2 copies*).
  - Overview con un bloque de salud (anillo *OK/total*, agentes detectados, editor actual) y una lista **To do** de lo accionable, cada cosa con su botón. Las carpetas vacías de la matriz se pliegan, las tarjetas de agente son compactas (*How to disable* desplegable) y Merge suggestions es un desplegable.
  - Esqueletos de carga. En pantallas anchas se abre el primer skill automáticamente.
  - Puntos de corte para paneles estrechos (980, 820, 640 y 460 px) y bordes reforzados en alto contraste.
- **Catálogo de skills** (Install → *Browse catalog*):
  - **Colecciones destacadas**, verificadas el 19-oct-2026: Anthropic, OpenAI, Awesome Copilot, Vercel, Microsoft, Hugging Face, NVIDIA y Superpowers.
  - Cada colección se lista al abrirla con 3 llamadas a la API más la descarga de los SKILL.md desde raw. Las descripciones se cachean en disco por blob SHA, así que volver a listar solo cuesta esas 3 llamadas.
  - **Search GitHub** busca en todos los repos públicos con la Code Search API, como `gh skill search`, y requiere sesión. Ordena primero las coincidencias en el nombre.
  - Marca lo que ya tienes instalado (mismo origen o mismo nombre).
  - *Install…* pasa la URL al flujo normal: análisis, staging, revisión de seguridad y confirmación.
- Tests del webview con jsdom en `npm run test:smoke`: todas las pestañas, acciones principales, host antiguo, scroll y catálogo.
- El webview se dividió en módulos (`store`, `dom`, `agents`, `skills`, `overview`, `map`, `install`, `catalog`, `main`).
- CI en GitHub Actions: typecheck, tests y smoke en Linux y macOS, más el VSIX como artefacto.
- **Skills de plugins de Claude Code** (solo lectura): se leen de `~/.claude/plugins/installed_plugins.json` y de `enabledPlugins` (managed > local > project > user; si nadie lo fija, decide `defaultEnabled`). Se muestran como `<plugin>:<skill>` y nunca chocan con los tuyos. Ajuste: `skillsManager.scanPlugins`.
- **Skills enterprise de Claude Code**: `.claude/skills` dentro del directorio de managed settings (macOS, Linux/WSL y Windows). Son de solo lectura y tienen la precedencia más alta.
- **Cursor recorre carpetas de categoría** (`skills/<grupo>/<skill>/SKILL.md`). Esos skills se listan con el chip `<grupo>/`, y si otros agentes leen la misma carpeta se avisa de que ellos no los ven.
- Actualizar un skill de `gh skill` ofrece **Update with gh skill…**: escribe `gh skill update <skill> --dir <carpeta>` en una terminal sin ejecutarlo.
- **Move to backup…** para los skills sincronizados de otra cuenta de claude.ai. Nunca toca la cuenta activa.
- **Encender / apagar por agente** (detalle del skill → *On / off per agent*), cada uno con su mecanismo documentado:
  - **Claude Code:** `skillOverrides`: On / Name only / Only /name / Off, en la configuración de usuario o en `.claude/settings.local.json` para los skills del proyecto, como el menú `/skills`.
  - **Codex:** `[[skills.config]] enabled = false` en `~/.codex/config.toml`. El editor de TOML solo toca esos bloques; hay que reiniciar Codex.
  - **Cursor y Copilot:** `disable-model-invocation` / `user-invocable` en el SKILL.md. Se avisa de que edita el skill y afecta a todos los agentes que respetan esas claves.

  Todos los cambios pasan por un modal que indica el archivo y guardan un backup. La lista marca *off: Claude*, *off: Codex*, *manual* y *disabled*.
- **Pestaña Config** (solo lectura): instrucciones, reglas, subagentes, comandos y servidores MCP de cada agente, con rutas verificadas en la documentación oficial (19-oct-2026).
  - **Instrucciones:** `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` y el `CLAUDE.md` gestionado; `AGENTS.md`, con la regla de Claude de leerlo solo si no hay `CLAUDE.md`; `AGENTS.override.md` de Codex; `copilot-instructions.md`.
  - **Reglas:** `.claude/rules`, `.cursor/rules/**/*.mdc` y `.github/instructions`.
  - **Subagentes y comandos:** `.claude/agents` y `.claude/commands`.
  - **MCP:** `.mcp.json`, `~/.claude.json` (usuario y local), `.cursor/mcp.json`, `.vscode/mcp.json`, el `mcp.json` del perfil de VS Code, `~/.copilot/mcp-config.json` y `[mcp_servers.*]` de Codex.
  - **Secretos:** de `env` y `headers` solo se muestran los nombres. Se ocultan los argumentos con pinta de credencial y las contraseñas de las cadenas de conexión, y las URLs se muestran sin query string.
  - Avisa cuando el mismo servidor MCP está en dos archivos de un mismo agente.
- Tests de punta a punta de los flujos con modales (`test/smoke/flows.test.mjs`): instalar, actualizar, arreglar, apagar por agente, quitar y fusionar, con la extensión empaquetada, modales confirmados y GitHub simulado.
- Corregido: dos backups de carpetas con el mismo nombre en el mismo milisegundo chocaban (`ENOTEMPTY`), lo que dejaba un merge a medias. Los nombres de backup ahora llevan un sufijo aleatorio.
- Corregido: dos escrituras simultáneas del lock (dos acciones seguidas) competían por el mismo archivo temporal. Ahora se serializan.
- Catálogo: añadida la colección **NVIDIA** (`NVIDIA/skills`, Apache-2.0, 418 skills).
- Corregido: el parser del frontmatter rechazaba valores YAML válidos repartidos en varias líneas indentadas, tanto sin comillas como entre comillas, y los que empiezan en la línea siguiente a `description:`. Esos skills (41 de NVIDIA y 2 de Vercel) salían sin descripción y **no se podían instalar**, porque el frontmatter se daba por inválido. Ahora se leen bien las 1.171 skills de las 8 colecciones.
- Corregido: el catálogo cortaba los SKILL.md de más de 256 KB. Ahora usa el mismo límite de 1 MB que la instalación.
- `npm run test:e2e`: ejecuta la extensión dentro de VS Code o Cursor reales, con un perfil temporal y un proxy local.

## 0.1.0 — 2026-10-18

Primera versión (MVP).

- Inventario de Agent Skills para Claude Code, Cursor, Codex y GitHub Copilot (global, workspace y admin).
- Matriz de visibilidad por agente, detección de duplicados, validación contra la spec de agentskills.io.
- Instalación desde GitHub con análisis, staging, inspección de seguridad, backup y rollback.
- Desinstalación segura (backup recuperable; symlinks: solo el enlace).
- Panel lateral, dashboard Webview y soporte de Workspace Trust.
