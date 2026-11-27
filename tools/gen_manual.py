# -*- coding: utf-8 -*-
"""Genera el Manual de usuario en Word (.docx) sin dependencias externas.

Uso:  python3 tools/gen_manual.py
Salida: docs/Manual-de-usuario-Inventarios-Aeroplasa.docx
"""
import zipfile, datetime
from xml.sax.saxutils import escape

OUT = "docs/Manual-de-usuario-Inventarios-Aeroplasa.docx"
body = []

def run(text, b=False, i=False, color=None, size=None):
    pr = ""
    if b: pr += "<w:b/>"
    if i: pr += "<w:i/>"
    if color: pr += f'<w:color w:val="{color}"/>'
    if size: pr += f'<w:sz w:val="{size}"/>'
    return f'<w:r>{"<w:rPr>"+pr+"</w:rPr>" if pr else ""}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'

def rich(text):
    """**negritas** dentro del texto."""
    out, parts = [], text.split("**")
    for k, p in enumerate(parts):
        if p: out.append(run(p, b=(k % 2 == 1)))
    return "".join(out)

def para(text, style=None, ind=None, keep=False, spacing_after=None, pagebreak=False):
    ppr = ""
    if style: ppr += f'<w:pStyle w:val="{style}"/>'
    if keep: ppr += "<w:keepNext/>"
    if pagebreak: ppr += "<w:pageBreakBefore/>"
    if spacing_after is not None: ppr += f'<w:spacing w:after="{spacing_after}"/>'
    if ind: ppr += f'<w:ind w:left="{ind}" w:hanging="300"/>'
    body.append(f'<w:p><w:pPr>{ppr}</w:pPr>{rich(text)}</w:p>')

def h1(t): para(t, "Heading1", pagebreak=True)
def h2(t): para(t, "Heading2", keep=True)
def h3(t): para(t, "Heading3", keep=True)
def p(t): para(t)
def bullets(items):
    for it in items: para("•\t" + it, ind=600, spacing_after=60)
def steps(items):
    for n, it in enumerate(items, 1): para(f"{n}.\t" + it, ind=600, spacing_after=60)
def note(t):
    body.append('<w:p><w:pPr><w:pStyle w:val="Nota"/></w:pPr>' + rich(t) + "</w:p>")

def table(header, rows, widths=None):
    n = len(header)
    widths = widths or [int(9000 / n)] * n
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    def cell(t, w, head=False):
        shd = '<w:shd w:val="clear" w:color="auto" w:fill="0F204A"/>' if head else ""
        r = run(t, b=True, color="FFFFFF") if head else rich(t)
        return (f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>{shd}</w:tcPr>'
                f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{r}</w:p></w:tc>')
    xml = ('<w:tbl><w:tblPr><w:tblStyle w:val="TablaGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
           f'<w:tblGrid>{grid}</w:tblGrid>')
    xml += "<w:tr><w:trPr><w:tblHeader/></w:trPr>" + "".join(cell(h, widths[k], True) for k, h in enumerate(header)) + "</w:tr>"
    for r in rows:
        xml += "<w:tr>" + "".join(cell(c, widths[k]) for k, c in enumerate(r)) + "</w:tr>"
    xml += "</w:tbl>"
    body.append(xml)
    body.append('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>')

def toc():
    body.append('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + run("Contenido") + "</w:p>")
    body.append('<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
                '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>'
                '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                + run("Haz clic derecho aquí y elige «Actualizar campo» para ver el índice.", i=True, color="666666") +
                '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')

# ============================ CONTENIDO ============================
fecha = datetime.date.today().strftime("%d/%m/%Y")
para("Manual de usuario", "Title")
para("Control de Inventarios Grupo Aeroplasa", "Subtitle")
p(f"Vehículos y refacciones · Versión de la app: v193 · Fecha: {fecha}")
p("Este manual explica cómo usar la aplicación para registrar y controlar el inventario de **vehículos** y de **refacciones** en las agencias del grupo. Está pensado para quien usa la app en el día a día: administradores, auditores, personal de refacciones, contabilidad, gerencia y operadores.")
toc()

# 1
h1("1. Primeros pasos")
h2("1.1 Abrir la aplicación")
p("La app funciona en el navegador del celular, la tableta o la computadora (se recomienda Google Chrome). Abre la dirección que te dio el administrador e inicia sesión con tu **usuario** y **contraseña**.")
h2("1.2 Instalarla en el celular")
steps([
    "Abre la app en Chrome.",
    "Toca el menú (⋮) y elige **Instalar aplicación** o **Agregar a la pantalla principal**.",
    "Desde ese momento se abre como cualquier otra aplicación, con su propio ícono.",
])
h2("1.3 Versión y actualizaciones")
p("La app se actualiza sola cuando hay internet. La versión aparece en pantalla (por ejemplo **v193**). Si te piden probar una versión nueva y no cambia, **cierra la app por completo** (o la pestaña) y vuelve a abrirla.")
h2("1.4 Conexión con el servidor")
p("La app guarda los datos en el equipo y los **sincroniza con el servidor** para que todos los equipos vean lo mismo. Si no hay internet, sigues trabajando y los cambios se suben solos al reconectar. Si un cambio no se pudo subir, la app muestra un aviso.")
note("Antes de un inventario de refacciones revisa en «Respaldo y conexión» que diga **Conectado**.")

# 2
h1("2. Roles y permisos")
p("El **rol** de cada usuario define qué pestañas ve y qué puede hacer. El administrador asigna el rol y dos casillas por usuario: **Acceso a vehículos** y **Acceso a refacciones**. Ningún usuario puede quedarse sin acceso a algún módulo.")
table(["Rol", "Qué puede hacer"], [
    ["Administrador", "Todo: vehículos y refacciones, agencias, usuarios, bitácora. Es el único que puede iniciar un inventario nuevo cuando ya hay uno en curso."],
    ["Auditor", "Ve vehículos y refacciones, escanea, mueve por zona, corre auditorías y **cuenta** refacciones (conteo y exhibición). No edita catálogos ni inicia inventarios nuevos."],
    ["Refacciones", "Solo el módulo de refacciones: carga archivos, genera muestras, cuenta, imprime etiquetas y reportes. Inicia inventarios nuevos solo si no hay uno en curso."],
    ["Contabilidad", "Consulta vehículos y refacciones con montos. Con la casilla **Puede editar** activada, también edita."],
    ["Gerente / Director", "Solo lectura en vehículos y refacciones. Sin escanear, mover por zona ni auditoría."],
    ["Capturista / Ventas", "Registra entradas, salidas y movimientos de vehículos y edita fichas."],
    ["Consultor / Asesor", "Consulta el inventario de vehículos (el asesor no ve montos)."],
    ["Operador", "Registra movimientos de vehículos."],
], [2300, 6700])

# 3
h1("3. Módulo de vehículos")
h2("3.1 Inicio (panel de control)")
p("Resumen del inventario: unidades por agencia y etapa, alertas de antigüedad (🟡 por vencer, 🔴 estancada) y pendientes. La campana 🔔 muestra las alertas.")
h2("3.2 Escanear: entradas, salidas y movimientos")
steps([
    "Entra a **Escanear** y lee el **QR o código de barras** de la etiqueta del vehículo (es el método más rápido y exacto). También puedes teclear el VIN de 17 caracteres o usar un lector USB.",
    "La app muestra los datos del VIN y sugiere la marca (verifícala en la ficha).",
    "Elige **Entrada** o **Salida**. La agencia se detecta por **GPS**.",
    "Toma las fotos de la **INE** (ambos lados) de quien recibe o retira la unidad; el pase de salida es opcional.",
    "Registra el movimiento.",
])
p("**Movimiento interno:** cambia el área dentro de la misma agencia (la agencia solo cambia por GPS al registrar entrada o salida).")
note("El registro manual sin GPS solo se habilita cuando **no hay internet** (contingencia).")
h2("3.3 Inventario")
p("Lista de unidades con filtros por agencia, etapa, marca, antigüedad y más. Desde la ficha se consulta el historial y se imprime la etiqueta de la unidad.")
h2("3.4 Mapa y reportes")
bullets([
    "**Mapa:** ubicación GPS de cada entrada, salida y movimiento.",
    "**Reportes:** existencias, antigüedad, unidades sin cambio de ubicación y exportaciones.",
])
h2("3.5 Etiquetas de vehículos")
p("Genera etiquetas con QR, código de barras y datos de la unidad para pegarlas en el vehículo y registrar movimientos al instante.")
h2("3.6 Mover por zona")
steps([
    "Escanea el **QR de la zona** pegado en el área.",
    "Escanea el QR de cada **unidad** que dejas en esa zona: su ubicación se actualiza sola.",
])
h2("3.7 Auditoría de vehículos")
steps([
    "Elige la agencia y el tipo de inventario. Puedes **congelar** el inventario para que no entren ni salgan unidades durante el conteo.",
    "Imprime la lista de unidades esperadas si quieres palomear en el recorrido.",
    "Escanea cada unidad (o captura el VIN a mano si la cámara no lee).",
    "Antes de cerrar, corrige diferencias: reasigna sobrantes o marca faltantes para investigación.",
])

# 4
h1("4. Módulo de refacciones")
p("El inventario de refacciones se trabaja **por agencia**: lo que cargas, cuentas y cierras en una agencia nunca se mezcla con otra.")
h2("4.1 Flujo general")
table(["Paso", "Inventario completo", "Inventario rotativo (muestra)"], [
    ["1", "Elegir agencia y tipo **Completo**", "Elegir agencia y tipo **Rotativo**"],
    ["2", "Subir existencias (y marbetes si aplica) → Cruzar → Cargar", "Subir existencias → elegir partes al azar o a mano"],
    ["3", "Imprimir etiquetas QR para anaqueles (si hace falta)", "Imprimir la **plantilla de conteo**"],
    ["4", "Conteo físico (1 a 3 conteos)", "Conteo físico de la muestra"],
    ["5", "Registrar exhibición / puntos de venta", "Registrar exhibición / puntos de venta"],
    ["6", "Reporte de diferencias", "Reporte de diferencias"],
    ["7", "Resultado final con firmas → **Cerrar auditoría**", "Resultado final con firmas → **Cerrar auditoría**"],
], [900, 4050, 4050])

h2("4.2 Iniciar un inventario")
steps([
    "En **Refacciones**, Paso 1: elige la **agencia**.",
    "Paso 2: elige **Completo** (todo) o **Rotativo** (una muestra de números de parte).",
])
h3("Candado de inventario en curso")
p("Si la agencia ya tiene un inventario **en curso** (iniciado y sin cerrar), la app lo indica con un aviso 🔒 y **solo el administrador** puede iniciar otro, cambiar el tipo o generar otra muestra. Para los demás, lo correcto es terminar y **cerrar** el inventario actual.")
h3("Iniciar nuevo inventario (vaciar la agencia)")
p("El botón **🗑 Iniciar nuevo inventario** borra las partes y conteos de trabajo de la agencia para empezar de cero (el **histórico** de inventarios cerrados no se borra). Hay que escribir **NUEVO** para confirmar.")
bullets([
    "Lo pueden usar el **administrador** y el rol **Refacciones**.",
    "Con un inventario en curso, solo el **administrador**.",
    "El auditor no ve este botón (solo cuenta).",
])

h2("4.3 Archivos que acepta la app")
table(["Archivo", "Columnas / forma", "Qué se toma"], [
    ["CSV de existencias (8 columnas)", "No. parte, Descripción, Existencia, Ubicación, Clasificación, Precio U., Valor, Fecha", "Todo: incluye precio (para el valor del inventario) y clasificación."],
    ["Archivo de ubicaciones (4 columnas)", "No. parte, Descripción, Existencia, Ubicación + fecha", "Parte, descripción, existencia y ubicación (sin precio ni clasificación)."],
    ["Reporte «Inventario x Almacén» (texto)", "Reporte del sistema con grupo «00-», importes y totales", "Parte con prefijo (00-…), existencia, precio, valor; compara contra el total del reporte."],
    ["PDF de marbetes", "Listado de marbetes del sistema", "Marbete y ubicación para cruzar con existencias (inventario completo)."],
], [2400, 3600, 3000])
note("Al subir un archivo, el mensaje indica cuántas partes se leyeron, cuántas traen **ubicación** y **clasificación**, y avisa de renglones no reconocidos o de ubicaciones dañadas por Excel.")
h3("Cuidado con Excel")
bullets([
    "Excel convierte algunas ubicaciones en números científicos (por ejemplo **2.04E+303**). Esas ubicaciones ya no son reales: la app no las imprime y avisa cuántas son.",
    "Excel también quita ceros al inicio del número de parte (01122023 → 1122023).",
    "Para evitarlo, exporta el archivo del sistema y súbelo **sin abrirlo ni guardarlo en Excel**, o marca esas columnas como **Texto** antes de guardar.",
])

h2("4.4 Etiquetas QR para anaqueles")
p("Tarjeta **🏷 Imprimir etiquetas QR para anaqueles**. Solo imprime: **no inicia un inventario ni guarda datos**.")
h3("Formato de la etiqueta")
table(["Elemento", "Detalle"], [
    ["Medida", "5.9 cm de ancho × 2.54 cm de alto"],
    ["Hoja", "Carta, 3 columnas × 10 filas = 30 etiquetas"],
    ["Contenido", "Código QR, número de parte, descripción (máx. 2 líneas), **ubicación** y **CLASIFICACIÓN**"],
    ["Clasificación", "Sale la letra del archivo (R, L, E, P, O, I). Si no viene, queda la línea «CLASIFICACION: ____» para llenar a mano."],
    ["Orden", "Por número de parte"],
], [2200, 6800])
h3("Cómo imprimir")
steps([
    "Toca **📄 Subir existencias** y elige el archivo.",
    "Deja marcado **Solo partes con existencia (> 0)** si no quieres etiquetas de partes en cero.",
    "Imprime primero la **Hoja de prueba (con bordes)** en papel normal y compárala contra tu hoja de etiquetas.",
    "Si no coincide, ajusta **Margen superior**, **Margen izquierdo**, **Separación horizontal** y **Separación vertical** (en milímetros).",
    "Imprime con **Imprimir etiquetas**.",
])
note("En la ventana de impresión usa **Escala 100 %** (o «Predeterminada», no «Ajustar a la página») y **Márgenes: Ninguno**. Con otra escala las etiquetas salen de otro tamaño.")
h3("Etiqueta suelta (refacción nueva)")
p("En **➕ Crear una etiqueta suelta** escribe número de parte, descripción, ubicación y cuántas copias; agrega a la lista e imprime. Sirve para refacciones que aún no están en el archivo.")

h2("4.5 Inventario completo: carga y cruce")
steps([
    "Sube el archivo de **existencias** (CSV o TXT).",
    "Si usas marbetes, sube el **PDF de marbetes** y toca **🔗 Cruzar** para unirlos por número de parte.",
    "Revisa la vista previa y toca **✓ Cargar al inventario**.",
])
h2("4.6 Inventario rotativo: muestra")
steps([
    "Sube el archivo de existencias (se conserva el inventario completo para calcular su valor total).",
    "Elige el modo: **Al azar** (indica la cantidad; puedes evitar partes ya auditadas antes) o **Manual** (pega los números de parte).",
    "Toca **Elegir al azar y cargar** o **Cargar estas partes**.",
    "Imprime la **📝 Plantilla de conteo** con las partes de la muestra.",
])
note("Si el administrador genera otra muestra cuando ya hay partes contadas, la app avisa cuántas son y pide confirmar, porque esos conteos se borran.")

h2("4.7 Conteo físico")
steps([
    "Elige el **número de conteos** (1 a 3). El 1.º cuenta todo; el 2.º y 3.º solo las partes que siguen con diferencia.",
    "Toca **📷 Escanear QR** y apunta a la etiqueta; suena un beep y la cámara se pausa.",
    "Teclea la **cantidad contada** y toca **Registrar conteo** (o Enter). La cámara vuelve a leer sola la siguiente parte.",
    "Si la cámara no lee, captura el número de parte a mano o con lector USB.",
    "Al terminar una ronda toca **Terminar conteo y pasar al siguiente** o **✓ Finalizar conteos**.",
])
table(["Sonido", "Significado"], [
    ["Pitido agudo corto", "Conteo registrado correctamente"],
    ["Pitido doble", "La parte no está en el inventario (o no es de la muestra rotativa)"],
    ["Pitido grave triple", "Dato inválido"],
], [3000, 6000])
p("**📍 Pendientes por ubicación** muestra lo que falta contar agrupado por ubicación, para recorrer el almacén en orden.")
p("**Reiniciar conteo** borra todos los conteos de la agencia (hay que escribir BORRAR). Con un inventario en curso solo lo puede hacer el administrador.")

h2("4.8 Exhibición y puntos de venta")
p("Registra las piezas que están físicamente en **exhibición, puntos de venta o armarios** y que el sistema tiene en almacén. **Se suman al conteo** para que cuadre contra la existencia.")
steps([
    "Escribe el número de parte, elige el **punto** y la cantidad; agrega una observación si hace falta.",
    "Usa **Sin ubicación** para piezas encontradas fuera de su lugar.",
    "Toca **Registrar**. Para corregir, usa el botón **✕** de la fila.",
])
note("Si el número de parte no está en el inventario (o no es de la muestra), la app pregunta antes de agregarlo.")

h2("4.9 Reporte de diferencias")
p("Muestra las partes donde el conteo (más exhibición) no cuadra con la existencia: **ajuste positivo** (sobran) y **ajuste negativo** (faltan), con su impacto en pesos. Se imprime en PDF o se exporta a CSV para capturar los ajustes en el sistema. Incluye la sección de **evidencia de exhibición** con observaciones.")

h2("4.10 Resultado final y cierre")
steps([
    "Revisa el resumen: valor del inventario completo y del subconjunto auditado (rotativo), monto de la diferencia, ajustes positivo y negativo, partes **sin diferencia** y no comprobadas, y el resumen por clasificación.",
    "Agrega a los **participantes / firmantes** (nombre y cargo).",
    "Toca **🖨 Imprimir resultado con firmas** y recaba las firmas.",
    "Toca **✓ Cerrar auditoría** para guardarla en el histórico. A partir de ahí ya se puede iniciar otro inventario.",
])
h2("4.11 Histórico, respaldo y conexión")
bullets([
    "**📚 Histórico de inventarios:** inventarios cerrados por agencia.",
    "**💾 Respaldo:** exporta un archivo con existencias y conteos por si falla la conexión, e impórtalo después.",
    "**🔄 Probar conexión:** confirma que el equipo está sincronizando con el servidor.",
])

# 5
h1("5. Administración")
h2("5.1 Agencias y ubicaciones")
p("Define las agencias, su centro GPS (botón «Usar mi ubicación actual») y sus áreas internas.")
h2("5.2 Usuarios")
steps([
    "Entra a **Usuarios** y llena nombre, correo, usuario, contraseña y **rol**.",
    "Marca **Acceso a vehículos** y/o **Acceso a refacciones** (al menos uno).",
    "En contabilidad, activa **Puede editar** si debe editar.",
    "Toca **Registrar usuario**. Los cambios de permisos se aplican la próxima vez que el usuario inicie sesión.",
])
h2("5.3 Bitácora")
p("Registro de las acciones realizadas (quién, qué y cuándo): movimientos, cargas, conteos, impresiones y cierres.")
h2("5.4 Ajustes")
bullets([
    "**Alertas de antigüedad:** días para marcar unidades por vencer o estancadas.",
    "**Catálogos:** listas para autocompletar (color, tipo, versión, transmisión).",
    "**OCR en la nube:** clave opcional para leer el VIN por foto (el método recomendado sigue siendo el QR).",
])

# 6
h1("6. Clasificación de refacciones")
table(["Letra", "Significado"], [
    ["R", "Rápido"], ["L", "Lento"], ["E", "Estancado"],
    ["P", "Próximo obsoleto"], ["O", "Obsoleto"], ["I", "Inactivo"],
], [1500, 7500])

# 7
h1("7. Solución de problemas")
table(["Problema", "Qué hacer"], [
    ["No aparece el botón «Nuevo inventario»", "Hay un inventario en curso (solo el administrador puede iniciar otro) o tu rol no tiene permiso de edición (el auditor solo cuenta). Cierra el inventario actual o pídelo al administrador."],
    ["La etiqueta no muestra la ubicación", "Revisa el mensaje al subir el archivo («Con ubicación: … de …»). Si la ubicación viene como 2.04E+303, Excel la dañó: corrige el archivo. Confirma que la app esté en la versión más reciente."],
    ["Las etiquetas no coinciden con la hoja", "Imprime con escala 100 % y márgenes «Ninguno». Haz la hoja de prueba y ajusta márgenes y separaciones en milímetros."],
    ["El escáner no se activa", "Permite el uso de la cámara en el navegador, usa buena luz y conexión a internet la primera vez. Como respaldo, captura a mano o con lector USB."],
    ["La app no cambia de versión", "Cierra la app o la pestaña por completo y vuelve a abrirla."],
    ["Aviso «no se pudo sincronizar»", "El cambio quedó solo en ese equipo. Revisa la conexión y vuelve a intentarlo; si persiste, avisa al administrador con el texto del aviso."],
    ["Aviso «captura de una muestra anterior»", "Ese conteo era de una muestra rotativa que ya se reemplazó; no se aplicó. Cuenta la parte de nuevo en la muestra actual."],
    ["Aviso «sin espacio en el navegador»", "Exporta un respaldo, cierra inventarios anteriores y libera espacio en el equipo."],
], [3000, 6000])

p("")
p("Para dudas o cambios, contacta al administrador del sistema.")

# ============================ EMPAQUETADO ============================
NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>'
            + "".join(body) +
            '<w:sectPr><w:footerReference w:type="default" r:id="rId3"/>'
            '<w:pgSz w:w="12240" w:h="15840"/>'
            '<w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="600" w:footer="600" w:gutter="0"/>'
            '</w:sectPr></w:body></w:document>')

def style(sid, name, size, bold=False, color="000000", before=0, after=120, based="Normal", pre="", post=""):
    # Orden del esquema de Word: keepNext/pBdr/shd → spacing → ind → outlineLvl.
    return (f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="{based}"/>'
            f'<w:next w:val="Normal"/><w:qFormat/><w:pPr>{pre}<w:spacing w:before="{before}" w:after="{after}"/>{post}</w:pPr>'
            f'<w:rPr>{"<w:b/>" if bold else ""}<w:color w:val="{color}"/><w:sz w:val="{size}"/></w:rPr></w:style>')

styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {NS}>'
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
    '<w:sz w:val="22"/><w:lang w:val="es-MX"/></w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + style("Title", "Title", 56, True, "0F204A", 1800, 120)
    + style("Subtitle", "Subtitle", 32, False, "1F4E99", 0, 360)
    + style("Heading1", "heading 1", 34, True, "0F204A", 120, 200, pre='<w:keepNext/>', post='<w:outlineLvl w:val="0"/>')
    + style("Heading2", "heading 2", 27, True, "1F4E99", 240, 100, pre='<w:keepNext/>', post='<w:outlineLvl w:val="1"/>')
    + style("Heading3", "heading 3", 23, True, "333333", 160, 80, pre='<w:keepNext/>', post='<w:outlineLvl w:val="2"/>')
    + style("Nota", "Nota", 21, False, "5A4500", 60, 160,
            pre='<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="F2B705"/></w:pBdr>'
                '<w:shd w:val="clear" w:color="auto" w:fill="FFF8E1"/>', post='<w:ind w:left="200"/>')
    + '<w:style w:type="table" w:styleId="TablaGrid"><w:name w:val="Tabla"/><w:tblPr>'
      '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>'
      '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>'
      '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders>'
      '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>'
      '</w:tblPr></w:style>'
    + "</w:styles>")

footer = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
          + run("Manual de usuario · Control de Inventarios Grupo Aeroplasa · Página ", color="808080", size=18) +
          '<w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
          '<w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
          '<w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>')

settings = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings {NS}>'
            '<w:updateFields w:val="true"/><w:defaultTabStop w:val="300"/></w:settings>')

ctypes = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    '</Types>')
rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    '</Relationships>')
docrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
    '</Relationships>')
now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    '<dc:title>Manual de usuario - Control de Inventarios Grupo Aeroplasa</dc:title><dc:creator>Grupo Aeroplasa</dc:creator>'
    f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
    f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>')

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", ctypes)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", document)
    z.writestr("word/styles.xml", styles)
    z.writestr("word/settings.xml", settings)
    z.writestr("word/footer1.xml", footer)
    z.writestr("word/_rels/document.xml.rels", docrels)
    z.writestr("docProps/core.xml", core)
print("OK", OUT)
