# Changelog

## 0.2.0 — 2026-10-18 (sin publicar)

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
- `npm run test:e2e`: ejecuta la extensión dentro de VS Code o Cursor reales, con un perfil temporal y un proxy local.

## 0.1.0 — 2026-10-18

Primera versión (MVP).

- Inventario de Agent Skills para Claude Code, Cursor, Codex y GitHub Copilot (global, workspace y admin).
- Matriz de visibilidad por agente, detección de duplicados, validación contra la spec de agentskills.io.
- Instalación desde GitHub con análisis, staging, inspección de seguridad, backup y rollback.
- Desinstalación segura (backup recuperable; symlinks: solo el enlace).
- Panel lateral, dashboard Webview y soporte de Workspace Trust.
