# Kopia Desk

MVP funcional de una app local para copias incrementales de carpetas como Imágenes, Documentos o Descargas.

Proyecto montado para:

```text
D:\Users\Admin\Documents\Kopia_Desk
```

Carpeta de prueba sugerida:

```text
D:\Users\Admin\Documents\Kopia_Desk\FOTOS
```

## Cómo abrir

Opción fácil: ejecuta `iniciar-kopia-desk.bat` y abre la dirección que muestra.

No abras `index.html` directamente si quieres usar el desplegable de discos. Ese desplegable necesita el servidor local `server.py`.

Opción manual:

```powershell
python server.py
```

Luego abre:

```text
http://127.0.0.1:4178/
```

## Qué hace

- Permite añadir una o más carpetas origen.
- Detecta discos conectados y permite elegir el destino desde una lista.
- Muestra espacio libre aproximado por disco.
- Escanea archivos de forma recursiva.
- Compara contra el último manifiesto guardado en el navegador.
- Detecta archivos nuevos, cambiados y eliminados del origen.
- No borra backups cuando un archivo desaparece del origen.
- Permite aceptar u omitir nuevos, cambiados y eliminados por carpeta.
 - Copia aceptados en `<disco>\KopiaDesk\<carpeta>\latest`.
 - Guarda versiones de archivos cambiados en `<disco>\KopiaDesk\<carpeta>\_versions\<fecha>`.
 - Crea registros JSON en `<disco>\KopiaDesk\<carpeta>\_logs`.
- Puede usar hash SHA-256 opcional para comparar contenido real.

## Nota del MVP web

El navegador lee las carpetas origen. El servidor local de Kopia Desk detecta discos y escribe los backups en el destino seleccionado.

## Siguiente paso natural

Convertir este MVP en Electron para activar detección real de discos, espacio disponible, empaquetado instalable y ejecución programada.
