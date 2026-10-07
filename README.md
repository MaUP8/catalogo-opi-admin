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
5. **Conectar el portal.** En `index.html` poner esa URL en `API_DEFAULT` y publicar.
   - Mientras tanto se puede abrir una vez el portal con `?api=URL`.

## Mantenimiento

- **Cambiar el código del backend:** editar en Apps Script → Implementar → Gestionar implementaciones → editar la existente → *Nueva versión*. Así la URL no cambia.
- **Token vencido:** el portal da error al leer o guardar. Generar uno nuevo y reemplazar `GITHUB_TOKEN`.
- **PIN del administrador olvidado:** volver a cargar `ADMIN_PIN` en las propiedades. En el próximo uso se reemplaza.
- **Dominio propio:** actualizar `SITIOS` en `index.html` con las URLs nuevas de los catálogos.
