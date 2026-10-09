# Portal de administración · Catálogos OPI

Portal interno para manejar los dos catálogos públicos:

- **Profesionales**: repo `MaUP8/catalogo-opi`
- **Interior del país**: repo `MaUP8/catalogo-opi-interior`

Desde el portal se cambian:

- los celulares de WhatsApp (si hay más de uno, la clienta elige a cuál enviar);
- el pedido mínimo y qué pasa si no se llega (se bloquea el envío o va a precio consumidor final);
- el Outlet 1+1 (encendido o apagado);
- qué productos se ocultan.

Stock y precios **no** se tocan acá: vienen del sistema dos veces por día.

Además:

- **Actualización automática.** El backend consulta el modelo publicado de Power BI (PBG-BI) de lunes a viernes entre las 8 y las 9 y entre las 12 y las 13. Recalcula disponibles, precios (profesional y consumidor final) y Outlet, y publica en los dos catálogos. Si los disponibles caen más de 40 % no publica y avisa por mail. En Historial se ve la última corrida y hay un botón *Actualizar ahora*.
- **Outlet.** Se elige la fecha de corte: entran los lotes con stock que ingresaron antes de esa fecha, y las reposiciones al mismo lote cuentan como nuevas (FIFO mensual). Además se pueden agregar tonos a mano, con todo su stock, y sacar tonos puntuales. La configuración vale para los dos catálogos.
- **Stock y precios.** Cada producto muestra precio profesional y consumidor final con impuestos; el stock vendible lo ven solo los administradores, que además pueden ordenar por stock.
- **Fotos.** Cada producto publicado tiene el botón *Foto* para reemplazar su imagen en los dos catálogos.
- **Sin publicar.** Lista los productos OPI con stock en el sistema que no están en los catálogos, sin cantidades. Desde ahí se publican con nombre, línea, familia, colección y foto: la foto se recorta y centra sola en 440×760 con fondo blanco. Los que no van se marcan *No va* y pasan a Descartados.

Cada cambio queda como commit en el repo del catálogo, en `data/config.json` o `data/ajustes.json`. El catálogo lo muestra en aproximadamente un minuto.

## Cómo está armado

```
Navegador (GitHub Pages: este repo)
   │  mail + PIN
   ▼
Backend (Google Apps Script, Web App en la cuenta de Mauri)
   │  token de GitHub guardado en Propiedades del script
   ▼
GitHub: data/config.json y data/ajustes.json de cada catálogo
```

- Los PIN se guardan con sal y hash (nunca en claro).
- La sesión dura 12 horas.
- Después de 5 intentos fallidos el mail queda bloqueado 15 minutos.
- El backend solo puede escribir esos dos archivos y valida su contenido. Por ejemplo, los teléfonos tienen que ser `598` + 8 dígitos.
- Solo el administrador agrega o quita usuarios. Los editores cambian los catálogos.
- El historial guarda los últimos cambios, con quién los hizo.

## Puesta en marcha (una sola vez)

1. **Token de GitHub** (lo crea Mauri). Ir a GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Repository access: *Only select repositories* → `catalogo-opi` y `catalogo-opi-interior`.
   - Permissions → Repository → **Contents: Read and write**. No hace falta nada más.
   - Vencimiento: el más largo que permita. Hay que anotar cuándo vence para renovarlo.
2. **Proyecto de Apps Script.** En script.google.com → Nuevo proyecto, nombrarlo "Portal catálogos OPI" y pegar `apps-script/Code.gs`.
3. **Propiedades del script** (Configuración del proyecto → Propiedades del script). Las carga Mauri:
   - `GITHUB_TOKEN`: el token del paso 1.
   - `ADMIN_EMAIL`: el mail del administrador.
   - `ADMIN_PIN`: un PIN inicial de 4 a 8 números. En el primer uso se guarda cifrado y la propiedad se borra sola.
4. **Implementar** → Nueva implementación → Aplicación web.
   - Ejecutar como: *Yo*.
   - Quién tiene acceso: *Cualquier persona*. El acceso real lo controla el mail + PIN.
   - Autorizar los permisos que pide Google y copiar la URL que termina en `/exec`.
5. **Conectar el portal** (hecho: implementación "Portal v1"). En `index.html` poner esa URL en `API_DEFAULT` y publicar.
   - Mientras tanto se puede abrir una vez el portal con `?api=URL`.

6. **Power BI.** Agregar a las propiedades del script los datos de la app de Azure que ya usa el conector PBG-BI publicado:
   - `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET`;
   - `PBI_DATASET_ID` y, si el modelo está en un área de trabajo, `PBI_WORKSPACE_ID`;
   - opcional: `PBI_COL_NOMBRE`, la columna de `PbiProductos` con el nombre del producto, si la detección automática no acierta.
7. **Disparador.** En el editor, elegir la función `diagnosticoPBI` y Ejecutar: el registro muestra las columnas y cuántos productos trae. Después ejecutar `instalarActualizacion` una sola vez.

## Mantenimiento

- **Cambiar el código del backend:** editar en Apps Script → Implementar → Gestionar implementaciones → editar la existente → *Nueva versión*. Así la URL no cambia.
- **Token vencido:** el portal da error al leer o guardar. Generar uno nuevo y reemplazar `GITHUB_TOKEN`.
- **PIN del administrador olvidado:** volver a cargar `ADMIN_PIN` en las propiedades. En el próximo uso se reemplaza.
- **Dominio propio:** catalogospbg.com (Cloudflare). Subdominios: opi (profesionales), opi-interior (interior), admin (este portal); CNAME a maup8.github.io con la nube en gris. Una marca nueva = un subdominio más y su URL en `SITIOS`.
