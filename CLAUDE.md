# Karumi Voice Demo Guide — contexto del proyecto

Guía de demo por **voz**. Narra una demo paso a paso y el usuario puede **interrumpir
hablando** para preguntar; la guía pausa, responde breve y reanuda desde el mismo paso
(el "Core Feature": interactividad en tiempo real / barge-in).

> **Ramas / qué se demuestra:** el MOTOR (voz, barge-in, anti-eco, motor human-like) es
> agnóstico del producto: las acciones (`type`/`pick`/`check`/`click`) apuntan a ids del
> DOM, así que sirve para CUALQUIER página. El "producto" demostrado vive solo en
> `public/index.html` + `demo-script.js`.
> - **`main`** → demo de un formulario de alta de cuenta de Google (un solo formulario largo).
> - **`crm`** → demo de un **CRM de ventas falso** (datos inventados): Dashboard, Contacts,
>   Opportunities (pipeline) y Communications. SPA de una sola página (las vistas se cambian
>   por JS sin recargar, para no destruir la sesión de voz / el WebSocket del STT). Feature
>   estrella: **redacción de correos con IA** (botón "Draft with AI" → `POST /api/draft` →
>   Claude). Pensada para desplegarse como un SEGUNDO servicio en Railway, sin tocar `main`.

## Stack

- **Cerebro:** Claude API (`@anthropic-ai/sdk`). Responde el Q&A. Modelo por defecto
  `claude-opus-4-8`; para baja latencia usar `claude-haiku-4-5` (var `CLAUDE_MODEL`).
- **Voz:** ElevenLabs TTS en streaming (`/api/tts`, GET, MP3 progresivo).
- **Oído + barge-in:** **Deepgram** streaming STT cuando hay `DEEPGRAM_KEY` (más preciso,
  no inventa con ruido, robusto al eco, no depende de Chrome/Edge); si no, **fallback** a la
  Web Speech API del navegador. La elección la decide el server (`/api/ear`) y el motor real
  vive detrás de `onSpeech(interim, final)` en `app.js`, así que la máquina de estados es
  idéntica para ambos. El audio del micro (ya con cancelación de eco, ver Anti-eco) se manda
  por WebSocket al **proxy del propio server** (`/api/listen`), que lo reenvía a Deepgram con
  la key —la key NUNCA llega al navegador—. Nota histórica: antes el oído era solo el
  navegador; se cambió porque inventaba palabras (sobre todo con eco) y era Chrome-only.
  Trade-off del proxy: el barge-in añade la latencia de red de Deepgram (parciales ~100-300ms)
  frente al parcial local instantáneo; en la práctica imperceptible.
- Backend: Node + Express (`server.js`) + `ws` para el proxy STT. Frontend vanilla en `public/`.
- **Relleno human-like:** la guía no solo narra, RELLENA el formulario como una persona
  (cursor pintado que se desliza por una curva, tecleo letra a letra con erratas que
  corrige, desplegables custom que se ven abrir, scroll con overshoot). Es un port a JS
  de navegador del motor de `hackathon-karumi/human_demo.py` (`public/human.js`).

## Mapa de archivos

- `server.js` — Express; endpoints `/api/demo`, `/api/answer` (Claude), `/api/tts` (ElevenLabs),
  `/api/ear` (qué STT usar), `/api/draft` (rama `crm`: Claude redacta `{subject, body}` para
  el CRM, salida forzada por la tool `email`) y el proxy WebSocket `/api/listen` → Deepgram
  (key server-side).
- `demo-script.js` — **único sitio** donde se edita el contenido de la demo. Cada paso:
  `narration` (lo que dice), `action`/`actions` (lo que HACE en el form: `type`/`pick`/
  `check`/`click`) y `context` (background para el Q&A).
- `public/human.js` — motor human-like (cursor `__cur`/`__hover`, glide bézier, `type`,
  `pick`, `click`, scroll progresivo). Cada acción recibe `keepGoing()` y aborta al instante
  si hay barge-in. Expone `window.Human`. Cargado ANTES de `app.js`.
- `public/app.js` — máquina de estados (idle/narrating/listening/answering), reproducción,
  barge-in y `performAction`/`runAction` que enrutan cada paso por `Human`.
- `public/index.html` — el "producto" (depende de la rama). En ambas: panel de la guía de voz
  (ids fijos que `app.js` necesita: `orb`/`status`/`startBtn`/`nextBtn`/`repeatBtn`/`stopBtn`/
  `transcript`) + desplegables custom con la convención `.dropdown`/`.dd-btn`/`.dd-opt[data-value]`/
  input hidden. La lógica propia del producto va inline en el HTML.
  - `main`: formulario de alta de Google.
  - `crm`: SPA del CRM (sidebar + vistas `view-dashboard|contacts|pipeline|comms`). Cambio de
    vista por JS (mostrar/ocultar `.view`), modal de contacto, pipeline con `advanceDeal`, y la
    redacción IA (`btn-draft` → `/api/draft` + preview en vivo). `contacts`/`deals` son arrays
    en memoria que se renderizan; `window.__resetProduct()` los devuelve a la semilla (lo llama
    `resetForm()` de `app.js` en cada arranque, para que un replay empiece limpio). OJO con el
    SPA: un paso que toca una vista oculta NO puede animarse (rect 0); por eso cada paso
    view-dependiente del `demo-script.js` empieza clicando su pestaña `nav-*`.

## Reglas del agente de voz (en el system prompt de `buildSystemPrompt`)

- **Inglés siempre**, nunca cambiar de idioma.
- Tono humano, conversacional, **sin jerga técnica**.
- Respuestas **muy breves** (1-2 frases) por la latencia de voz.
- Solo el texto a pronunciar (sin preámbulos ni meta-comentarios).
- Mantener el contexto del paso actual durante el Q&A.
- **Salida estructurada vía tool `reply` (forzada con `tool_choice`):** el cerebro NO
  devuelve texto libre, devuelve `{ text, checkIn }`. `text` es solo la respuesta (sin
  coletilla de cierre tipo "does that make sense?"); `checkIn` es el JUICIO del modelo sobre
  si conviene un chequeo de claridad hablado después (true solo si la respuesta puede dejar
  dudas; false si la zanjó, era trivial, o el propio `text` ya acaba preguntando). El cliente
  añade la pregunta de validación SOLO si `checkIn` es true. Sin `thinking` (latencia); forzar
  la tool ya evita que Opus 4.8 filtre razonamiento.

## Comportamiento conversacional (orquestación en `public/app.js`, no en el prompt)

Turn-taking humano, paciente y con memoria estricta unidireccional:

- **VAD / barge-in FULL-DUPLEX (core feature, NO sacrificar):** en cuanto el usuario habla
  mientras el agente produce salida (narrando, RELLENANDO el form, o diciendo acuse/validación/
  respuesta/transición), se corta el audio AL INSTANTE. El micro NUNCA se silencia mientras el
  agente habla — interrumpir en cualquier momento es la feature central. Que el agente no
  reaccione a su PROPIO eco se resuelve sin mutear, con las capas anti-eco (ver "Anti-eco").
  Umbral `BARGE_MIN_WORDS = 2` (suelo anti-ruido); un hit de 2 palabras debe persistir una
  segunda lectura (`bargePrimed`), uno de `>= BARGE_CONFIRM_WORDS` corta al instante.
- **Interrupción + ESPERA PACIENTE ESCALONADA (`onQuietBeat`):** corte → en silencio, el
  agente escala como una persona en vez de esperar infinito o reanudar de golpe. Toque 1
  (tras `ACK_DELAY`): invita la pregunta (`ACKS`, "what's your question?"). Toque 2 (tras
  `QUIET_DELAY`): la re-pregunta (`REPROMPTS`, "sorry, what was it?"). Toque 3: da por hecho
  que no hay pregunta, dice una frase de cierre (`GIVEUPS`) y reanuda (esa frase SUSTITUYE a
  la transición). El contador es `state.quietBeats`; cada habla del usuario reprograma el
  temporizador (`rescheduleQuiet`) para no cortarle. Si interrumpe con la pregunta del tirón,
  contesta directo. **Excepción — PAUSA (`one moment`, `acceptPause`):** marca la espera como
  `waitingFor="pause"`, que NO tiene temporizador → se espera indefinidamente (una pausa no es
  una pregunta pendiente). Si nuestra PROPIA respuesta acaba preguntando algo
  (`endsWithQuestion`), no reanudamos: `holdForReply` espera su réplica con la misma escalación.
- **Bucle Q&A con validación CONDICIONAL (la decide el cerebro):** tras responder, la
  pregunta de validación ROTADA (`VALIDATIONS`) se hace SOLO si aporta. Si la respuesta acaba
  en pregunta (`endsWithQuestion`) → `holdForReply` (esperar su réplica, NO reanudar ni apilar
  validación). Si no, `answerQuestion` omite la validación y reanuda directo cuando: la
  intervención fue un comentario puro (`isPureComment`) o el cerebro marcó `checkIn=false`.
  Si se hace, la validación es siempre un CHEQUEO DE CLARIDAD coherente:
  aprobación (`APPROVE`/`CLOSE`/`RESUME`/`CONTINUE`) → reanuda; negación (`DENY`) → `clarify()`
  (`CLARIFIES`); otra pregunta → responde y re-evalúa. El pool `VALIDATIONS` NO debe mezclar
  sondeos tipo "any other questions?" (ahí "no" significaría "sigue", invirtiendo el routing y
  reabriendo el bucle "te digo no y me repregunta").
- **Memoria estricta / checkpoint (forward-only):** el progreso se guarda a nivel de
  acción: `stepIndex` + `actionIndex` + `narrated`. `runSteps()` solo ejecuta lo NO
  completado; una acción completada avanza su índice y **no se repite jamás** (no rerellena
  campos). Solo se re-narra una narración interrumpida (incompleta); una acción interrumpida
  se reanuda solo esa.
- **Reanudación:** transición ROTADA (`TRANSITIONS`) + `startRun()` desde el checkpoint
  exacto, sin repetir pasos/campos ya hechos.
- **Sin repetición de frases:** `makeRotator` nunca devuelve la misma dos veces seguidas.
- **Robustez de turnos:** cada turno nuevo hace `bumpGen()`; los `await speak(...)`
  comprueban su `gen`/`alive(g)` al volver y abortan si fueron superados (evita
  reanudaciones fantasma). `stopAudio()` resuelve la promesa de `speak()`, así los `await`
  se cierran de forma determinista al cortar.
- **Comandos:** `next` (saltar al paso siguiente, no rerellena el saltado), `repeat`
  (re-narra el paso actual sin rerellenar), `stop`.
- **Idioma de las frases:** las bolsas (`ACKS`/`VALIDATIONS`/`CLARIFIES`/`TRANSITIONS`)
  están en inglés (demo en inglés). Para español, traducirlas y poner `rec.lang = "es-ES"`.

## Anti-eco / speaker feedback (PL-AEC) — LEER antes de tocar nada de esto

Síntoma recurrente: SIN auriculares, el micro capta el propio TTS por el altavoz, el STT
lo transcribe (a menudo INVENTANDO palabras, no literales) y el agente se auto-interrumpe
o responde a sí mismo. La defensa está EN CAPAS y el orden importa — atacar solo la última
capa (texto) es lo que hacía que el problema volviera una y otra vez:

NOTA: se PROBÓ medio-dúplex (silenciar el micro mientras el agente habla) y se DESCARTÓ a
propósito: mataba el bucle pero sacrificaba el barge-in, que es la feature central. El micro
queda SIEMPRE vivo; el bucle se mitiga solo con las capas 1-4. Si reaparece sin auriculares,
la salida es AEC mejor o auriculares — NO volver a mutear el micro.

1. **AEC acústica (defensa PRIMARIA, `acquireMic`):** `getUserMedia({ echoCancellation,
   noiseSuppression, autoGainControl })`. Ese track ya cancelado es el que se usa: o se pasa
   a la Web Speech API (`startBrowserRecognition`, Chrome 139+ acepta `start(MediaStreamTrack)`)
   o se mete en el `MediaRecorder` que alimenta el proxy de Deepgram. El navegador resta la
   salida del altavoz ANTES de que el STT vea el audio. El TTS sale por `<audio>` normal, así
   que entra en la referencia del cancelador (lo que NO cancelaría es audio de la Web Audio API;
   no se usa). Esto NO se arregla mejorando el modelo de ElevenLabs: el eco es de ENTRADA, el
   TTS es de SALIDA — capas ortogonales. Pagar más TTS no toca el problema.
2. **STT preciso (Deepgram):** un transcriptor de producción casi no inventa con ruido normal,
   así que el "inventar por eco residual" baja mucho frente al navegador. Es la razón principal
   del cambio de oído. (El navegador sigue como fallback y es el caso peor para el eco.)
3. **Suelo de ruido + debounce (backstop, en `onSpeech`):** fragmentos `< 2` palabras sin
   intención real se descartan (`isMeaningfulShort` exime comandos/sí-no/pausa); un barge-in
   borderline debe persistir dos lecturas. Atrapa residuo que la AEC y el STT dejen.
4. **Filtro de texto (última red, `isEcho`):** compara el input con las últimas frases del
   agente (`echoWords`/`echoPrevWords`) por subcadena contigua de palabras, SOLO dentro de la
   ventana audible (`ECHO_TAIL_MS`). Es la red más débil: si el STT inventa palabras, el texto
   no coincide y esta capa no puede atraparlo. NO es el mecanismo principal.

Si tras esto el residuo aún molesta en hardware concreto: escalar a STT cloud con AEC
(Deepgram Nova-3, ~$0,0077/min, $200 crédito inicial → gratis para este uso) manteniendo
Claude+TTS, o al stack gestionado de ElevenLabs Conversational AI (~$0,08-0,10/min). La
fiabilidad 100% real sigue siendo cascos o medio-dúplex (interrumpir por tecla, sin barge-in).

## Notas

- Requiere Chrome/Edge (Web Speech API). Con AEC (Chrome 139+) ya NO hacen falta auriculares;
  siguen siendo el único modo 100% libre de eco si el altavoz/sala son malos.
- `thinking` desactivado en `/api/answer` a propósito (latencia); el prompt evita que
  Opus 4.8 filtre razonamiento en la respuesta visible.
- Claves en `.env` (no se commitea). `ANTHROPIC_API_KEY` y `ELEVENLABS_API_KEY` requeridas.
- Alternativa de producción: ElevenLabs Conversational AI (Agents) con Claude como custom LLM
  gestiona todo el bucle de voz y el barge-in; aquí se usan las APIs crudas para control total.
