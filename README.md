# TestForge

Pruebas de API, UI/E2E y seguridad en una sola aplicación web, pensada para testers.

**Estado actual:** módulos de **API**, **UI**, **carga/estrés**, **seguridad**, **importación** y **CLI para CI** funcionando de punta a punta.

### Pruebas de API

- Proyectos con URL base y **entornos** con variables (`{{host}}`, `{{user}}`…).
- **Requests** tipo Postman: método, URL, cabeceras, cuerpo y botón **Enviar**.
- **Aserciones**: código de estado, tiempo de respuesta, cabeceras, campos JSON (`data.items[0].id`), texto en el cuerpo y **esquema JSON**.
- **Capturas**: guarda un valor de la respuesta (p. ej. un token) y úsalo en los siguientes requests.
- **Ejecutar colección**: corre todos los requests en orden mediante una cola y un worker.
- **Reporte** con resumen, esperado vs. obtenido, cuerpo y cabeceras, y descarga en **JUnit XML** para CI.

### Pruebas de UI (Playwright)

- Editor de código (el mismo de VS Code) con la sintaxis estándar de **Playwright**: `page`, `expect`, `vars`.
- Menú **+ Insertar paso…** con plantillas para ir a una página, llenar formularios, verificar textos, URL, título, etc.
- Ejecución en **Chrome, Firefox y Safari (WebKit)**, una prueba o todas.
- Reporte con el **error esperado vs. recibido**, **captura de pantalla**, **video** y **traza paso a paso** (Trace Viewer de Playwright) de cada fallo.
- Si una prueba tiene un error de sintaxis, se marca con la línea exacta y las demás siguen ejecutándose.

Próximo: importar colecciones de Postman, CLI para CI, login de usuarios y escaneo de seguridad con OWASP ZAP.

---

## Instalación en Windows (una sola vez)

1. **Node.js LTS**: descárgalo de <https://nodejs.org> e instálalo con las opciones por defecto.
2. **Docker Desktop**: descárgalo de <https://www.docker.com/products/docker-desktop/>. Si te lo pide, acepta instalar WSL 2 y reinicia el PC. Abre Docker Desktop y espera a que diga *Engine running*.
3. **pnpm** (gestor de paquetes del proyecto). Abre **PowerShell** y ejecuta:

   ```powershell
   npm install -g pnpm
   ```

4. **VS Code** (opcional, recomendado): <https://code.visualstudio.com>.

## Arrancar la aplicación

En PowerShell:

```powershell
cd $HOME\Documents\testforge
pnpm install          # solo la primera vez o cuando cambien dependencias
pnpm ui:browsers      # solo la primera vez: descarga Chrome, Firefox y WebKit para Playwright (~500 MB)
pnpm infra:up         # levanta PostgreSQL, Redis y OWASP ZAP en Docker
pnpm dev              # arranca API, worker y la web
```

Abre <http://localhost:5173> en el navegador.

La configuración por defecto ya apunta a los contenedores de Docker. Si necesitas cambiar puertos o contraseñas, copia `.env.example` como `.env` y edítalo.

Para detener: `Ctrl + C` en la terminal y luego `pnpm infra:down`.

## Probarlo en 2 minutos

1. **+ Nuevo proyecto** → nombre `JSONPlaceholder`, URL base `{{host}}`.
2. Pestaña **Entornos y proyecto** → **+ Nuevo entorno** → cambia `host` a `https://jsonplaceholder.typicode.com` → **Guardar**.
3. Elige ese entorno arriba a la derecha.
4. Pestaña **Requests API** → **+ Nuevo request** → URL `/users/1` → aserciones:
   - Código de estado igual a `200`
   - Campo JSON `name` existe
   - Tiempo de respuesta menor que `2000` ms
5. **Enviar** para verlo al momento, o **Ejecuciones y reportes → Ejecutar colección** para el reporte completo.

## Tu primera prueba UI

1. En **Entornos y proyecto**, pon la **URL base de UI**, por ejemplo `https://demo.playwright.dev` → **Guardar proyecto**.
2. Pestaña **Pruebas UI** → **+ Nueva prueba UI** y reemplaza el código por:

   ```ts
   await page.goto("/todomvc");
   await page.getByPlaceholder("What needs to be done?").fill("Comprar pan");
   await page.keyboard.press("Enter");
   await expect(page.getByTestId("todo-title")).toHaveText(["Comprar pan"]);
   ```

3. Elige los navegadores y pulsa **▶ Ejecutar prueba**. Cambia `"Comprar pan"` en la última línea por otro texto para ver cómo se reporta un fallo.

Ojo: la URL base debe ser solo el dominio (sin ruta). Una ruta que empieza con `/` en `page.goto` se une al dominio.

Las variables del entorno se usan como `vars.usuario`, `vars.password`, etc. Toda la sintaxis está en <https://playwright.dev/docs/writing-tests>.

Las capturas, videos y trazas se guardan en la carpeta `data/artifacts` del proyecto.


## Importar Postman / OpenAPI

En "Requests API" pulsa **⇪ Importar Postman / OpenAPI**, pega el JSON (o elige el archivo) y se crean los requests:

- **Postman v2.1:** respeta carpetas, cabeceras, cuerpo, variables de la colección y traduce aserciones simples de los tests.
- **OpenAPI 3:** crea un request por operación, arma la URL con `{{host}}`, genera un cuerpo de ejemplo desde el esquema y añade la aserción del código de respuesta.

## Grabador de pruebas UI

En "Pruebas UI" pulsa **⦿ Grabar prueba**: se abre un navegador en tu PC, navegas y haces clics, y al cerrar la ventana se crea una prueba con el código generado (sintaxis Playwright). Requiere los navegadores (`pnpm ui:browsers`) y solo funciona donde la app tiene pantalla (tu equipo, no un servidor).

## Seguridad (OWASP ZAP)

Pestaña **Seguridad**. Usa [OWASP ZAP](https://www.zaproxy.org/), que se levanta con `docker compose` junto a la base de datos.

- **Escaneo pasivo:** explora el sitio y revisa el tráfico sin atacar (cabeceras, cookies, fugas de información). No modifica nada.
- **Escaneo activo:** además prueba vulnerabilidades enviando peticiones maliciosas (XSS, inyección…). **Envía ataques reales**, así que pide una confirmación explícita y solo debe usarse en entornos de prueba propios o autorizados.
- Los hallazgos se muestran por severidad (alta/media/baja/informativa) con su CWE, evidencia y cómo corregirlos. Un hallazgo de severidad **alta** hace fallar la ejecución (y el pipeline).

> **Uso responsable:** escanea únicamente sistemas de tu propiedad o para los que tengas permiso por escrito. Un escaneo activo contra sistemas ajenos puede ser ilegal.

## CLI para CI/CD

Ejecuta tus pruebas desde la terminal o un pipeline. La API (`pnpm dev` o solo `pnpm --filter @testforge/api start` + worker) debe estar corriendo y accesible.

```bash
# Listar proyectos y sus ids
pnpm cli projects

# Pruebas de API (guarda JUnit para CI)
pnpm cli run -p "Mi API" --kind api --junit resultados.xml

# Pruebas UI en varios navegadores
pnpm cli run -p "Tienda" --kind ui --browsers chromium,firefox

# Carga con umbrales (falla el pipeline si no se cumplen)
pnpm cli run -p "Mi API" --kind load --vus 100 --duration 120 --p95 800 --error-rate 1
```

La CLI **devuelve código 0 si la ejecución pasó y 1 si falló**, así el pipeline se detiene solo. Opciones completas: `pnpm cli run --help`.

Apunta a otra API con `--api https://...` o la variable `TESTFORGE_API`.

### Ejemplo: GitHub Actions

```yaml
name: Pruebas TestForge
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g pnpm && pnpm install
      - run: docker compose up -d && sleep 5
      - run: pnpm --filter @testforge/api start & pnpm --filter @testforge/worker start &
      - run: sleep 5
      - run: pnpm cli run -p "Mi API" --kind api --junit resultados.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: resultados, path: resultados.xml }
```

### Ejemplo: GitLab CI

```yaml
pruebas:
  image: node:22
  services: [docker:dind]
  script:
    - npm install -g pnpm && pnpm install
    - docker compose up -d && sleep 5
    - pnpm --filter @testforge/api start & pnpm --filter @testforge/worker start & sleep 5
    - pnpm cli run -p "Mi API" --kind api --junit resultados.xml
  artifacts:
    when: always
    reports:
      junit: resultados.xml
```

## Estructura

```
apps/
  api/        API REST (Fastify) — proyectos, entornos, requests, ejecuciones, JUnit
  cli/        Línea de comandos para CI/CD (testforge run …)
  worker/     Toma ejecuciones de la cola (BullMQ/Redis) y las corre
  web/        Interfaz (React + Vite)
packages/
  shared/     Tipos y validaciones (Zod) compartidos
  engine-api/ Motor de pruebas de API: variables, aserciones, capturas
  engine-ui/  Motor de pruebas UI: genera specs de Playwright, los ejecuta y lee el reporte
  engine-load/ Motor de carga: usuarios virtuales, etapas, percentiles y umbrales
  engine-security/ Orquesta OWASP ZAP (escaneo pasivo/activo) y agrupa hallazgos
  db/         Conexión a PostgreSQL y esquema
docker-compose.yml   PostgreSQL 16 + Redis 7
```

## Comandos útiles

| Comando | Qué hace |
| --- | --- |
| `pnpm dev` | Arranca todo en modo desarrollo (se recarga al guardar) |
| `pnpm test` | Pruebas automáticas de los motores de API y UI |
| `pnpm ui:browsers` | Descarga o actualiza los navegadores de Playwright |
| `pnpm cli run …` | Ejecuta pruebas desde la terminal / CI |
| `pnpm typecheck` | Revisa tipos de TypeScript en todo el proyecto |
| `pnpm infra:up` / `pnpm infra:down` | Enciende / apaga PostgreSQL y Redis |

## Problemas comunes

- **"No se pudo conectar con la API"**: revisa que Docker Desktop esté abierto y que `pnpm infra:up` haya terminado sin error.
- **Puerto 5432 ocupado**: ya tienes otro PostgreSQL instalado. Detenlo o cambia el puerto en `docker-compose.yml` y en `.env`.
- **`pnpm` no se reconoce**: cierra y vuelve a abrir PowerShell tras instalarlo.
- **"Faltan los navegadores de Playwright"**: ejecuta `pnpm ui:browsers`.
- **`net::ERR_UNSAFE_PORT`** en una prueba UI: Chrome bloquea algunos puertos (por ejemplo 5060 y 6000). Usa otro puerto para tu app.

## API REST (resumen)

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET/POST | `/api/projects` | Listar / crear proyectos |
| GET/POST | `/api/projects/:id/environments` | Entornos |
| GET/POST | `/api/projects/:id/requests` | Requests |
| POST | `/api/projects/:id/send` | Ejecutar un request al momento |
| POST | `/api/projects/:id/runs` | Lanzar una ejecución de la colección |
| GET | `/api/runs/:id` | Reporte de una ejecución |
| GET/POST | `/api/projects/:id/ui-tests` | Pruebas UI |
| POST | `/api/projects/:id/runs` con `{"kind":"ui","browsers":["chromium"]}` | Ejecutar pruebas UI |
| GET | `/api/runs/:id/junit.xml` | Reporte JUnit para CI (API y UI) |
| GET | `/api/artifacts/...` | Capturas, videos y trazas |
