# QA — Sales CRM (demo por voz)

Guía para probar **por voz** todo lo que no se puede verificar de forma automática.
En cada punto: **Di** lo que está entre comillas (en inglés, la demo es en inglés) y comprueba **Debe**.

## Antes de empezar
- [ ] Estás en la rama **`crm`** (tiene todo, incl. navegación por pasos). Producción (`main`) aún no la tiene hasta que mergeemos.
- [ ] `npm start` y abre **http://localhost:3000** en **Chrome**.
- [ ] **Cascos** puestos.
- [ ] Al pulsar **Start**, **permite el micrófono**.

---

## 1. Arranque y reproducción
- [ ] Pulsa **Start** y permite el micro. **Debe:** aparece el cursor, empieza a narrar y a rellenar (el cursor se desliza, teclea con alguna errata que corrige). Mientras teclea, **debe** ir hablando a la vez (concurrencia).
- [ ] Déjalo correr un par de pasos sin tocar nada. **Debe:** avanzar de sección con normalidad.

## 2. Interrupción (barge-in)
- [ ] Mientras habla, **di** cualquier cosa ("sorry"). **Debe:** corta el audio al instante y se pone a escuchar.
- [ ] **Dos interrupciones seguidas rápidas:** interrúmpele, y en cuanto pare vuelve a hablar. **Debe:** no liarse ni hablar encima de ti.
- [ ] Interrúmpele y **quédate callado** (no preguntes nada). **Debe:** tras una pausa, te invita ("go ahead / what's your question?"); si sigues callado, repregunta; si sigues callado, sigue solo ("no worries, I'll carry on").

## 3. Preguntas y check-in rotativo
- [ ] Interrúmpele y **di:** "what does the win rate mean?". **Debe:** responde breve y luego hace **un** check-in. Apunta cuál de los tres sale.
- [ ] Cuando salga **"anything else?"** → **di** "no". **Debe:** continúa la demo.
- [ ] Cuando salga **"want me to carry on? / shall I keep going?"** → **di** "yes". **Debe:** continúa.
- [ ] Cuando salga **"did that answer your question? / does that make sense?"** → **di** "no". **Debe:** te lo reexplica (no continúa).
- [ ] Tras cualquier check-in, en vez de sí/no, **di otra pregunta** ("what's a qualified lead?"). **Debe:** la responde y **vuelve a hacer otro check-in** (distinto del anterior).
- [ ] Verifica que **no sale siempre el mismo** check-in.

## 4. Pausa
- [ ] Interrúmpele y **di:** "one moment" (o "give me a second"). **Debe:** dice algo tipo "what's up? / what's on your mind?" y **espera**. Quédate callado un rato: **debe seguir esperando** (la pausa NO se reanuda sola).
- [ ] Luego **di** tu pregunta. **Debe:** la responde con normalidad.

## 5. Pregunta anunciada + esperas escalonadas
- [ ] Interrúmpele y **di:** "excuse me, I have a question" (sin hacerla aún). **Debe:** responde "what's your question?" y espera.
- [ ] Quédate **callado** unos segundos. **Debe:** repregunta ("sorry, what was your question?").
- [ ] Sigue callado. **Debe:** se rinde con gracia ("no worries, I'll carry on") y continúa.

## 6. Comandos por voz
- [ ] **Di:** "next". **Debe:** salta al siguiente paso.
- [ ] **Di:** "repeat". **Debe:** vuelve a narrar el paso actual sin re-rellenar lo ya hecho.
- [ ] **Di:** "stop". **Debe:** termina la sesión.

## 7. Navegación por secciones
- [ ] **Di:** "show me the pipeline". **Debe:** va a Pipeline y lo explica.
- [ ] **Di:** "go to communications", luego "take me to the dashboard", luego "back to contacts". **Debe:** salta a cada una.

## 8. Navegación por pasos (lo nuevo)
- [ ] **Di:** "add a contact" / "create a contact". **Debe:** va al paso de crear contacto.
- [ ] **Di:** "draft an email". **Debe:** va a redactar el correo.
- [ ] **Di:** "move a deal to the next stage". **Debe:** va a avanzar un deal.

## 9. Navegar a media acción (con el popup abierto)
- [ ] Cuando esté **a punto de / a mitad de crear un contacto** (popup abierto), **di:** "no, go to communications". **Debe:** **cierra el popup**, abandona el contacto y va a Communications. (No debe decir "termino y luego voy".)
- [ ] Repite: a mitad de crear, **di:** "no, edit a contact instead". **Debe:** cierra el popup de crear, abre Contacts y va a **editar**.

## 10. Reenseñar lo saltado
- [ ] Tras saltarte la creación (punto anterior), **deja que siga** sin pedirle nada. **Debe:** más adelante **vuelve a enseñarte la creación del contacto** por su cuenta.

## 11. Terminar / cierre
- [ ] A media demo, **di:** "I think we've seen everything, leave it here". **Debe:** se despide y **termina** (NO dice "let's continue").
- [ ] Reinicia y pruébalo también con **"I'm good"** y con **"that's enough"**. **Debe:** cerrar igual.

## 12. Correo con IA
- [ ] En Communications, deja que **redacte** el correo. **Debe:** sale un email real (asunto + cuerpo) y la preview en vivo a la derecha.
- [ ] **Di:** "why did you write it that way?". **Debe:** lo explica brevemente.

## 13. Botones del dock (Start demo / Continue / Stop)
- [ ] Con la demo corriendo, pulsa **Stop**. **Debe:** se pausa; **Continue se resalta** (color de Start demo), **Start demo** pasa a **"Restart demo"** y **Stop** pasa a **"Finish"**.
- [ ] Pulsa **Continue**. **Debe:** reanuda donde se quedó y los botones **vuelven a la normalidad**.
- [ ] Pausa otra vez y pulsa **Restart demo**. **Debe:** reinicia desde cero (3 contactos semilla, Dashboard, deals iniciales, sin email redactado).
- [ ] Pausa otra vez y pulsa **Finish**. **Debe:** termina la sesión del todo.
- [ ] (Ya no hay botón **Repeat**; el comando de voz "repeat" del punto 6 sigue funcionando.)

## 14. Visual / pulido
- [ ] Pestaña dice **"Sales CRM"** y favicon **robot**.
- [ ] CRM a **pantalla completa**; el dock arriba a la derecha **no tapa** "New contact".
- [ ] Al redactar el correo la **página no crece** (scrollea dentro del panel, no la pestaña entera).

## 15. Robustez extra
- [ ] **Sin cascos** un momento (sube el volumen): comprueba que **no se auto-interrumpe** con su propio eco mientras habla.
- [ ] Recarga, pulsa Start y **bloquea** el micro. **Debe:** sale un **aviso discreto** ("Microphone blocked…") y no se queda mudo sin explicación.

---

Si algo falla, anota el **número del punto** y el comportamiento observado.
