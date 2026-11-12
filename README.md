# ioBroker.smart-text2command

An ioBroker adapter for local natural-language device control. Development follows the [technical specification](documentation/ioBroker.smart-text2command_SPECIFICATION.md).

## Current state

Phases 0–4 are implemented. The adapter discovers ioBroker objects and room/function enums, maps conservative device capabilities, and stores a registry in the instance data directory. Every new device is disabled and every action requires a separate approval tied to the current capability fingerprint. A changed target, type, range, or mapping invalidates the affected approval. Critical and unknown roles are not executable.

NLP.js classifies German and English requests using a versioned local model. Training runs in a worker thread when no valid model exists or the supplied training data changes. A new model is activated only after fixed regression cases pass. Device names and aliases are resolved from the current registry without retraining. User intents have separate persistent storage with typed action validation.

The `sendTo` API accepts `processText` with `mode: "analyze"` or `mode: "execute"`. Execution requires a current per-action approval and rechecks the target object immediately before access. `input.text` only analyzes; it cannot execute. Results appear in `output.response`, `output.result`, and `output.status`. Admin-only message commands manage devices, typed user intents, model training, rollback and diagnostics. Admin mutation requires an authenticated admin sender and an administrator group member.

### Follow-up questions from another adapter

The complete contract and an adapter-side `sendTo` example are in [documentation/SENDTO_API.md](documentation/SENDTO_API.md).

Send a new `requestId` for every turn. A request containing only `text` (with or without `sessionId`) starts a new command. When the result has `status: "clarification"`, keep its `clarification.id` and send it with the next short answer, using the same `sessionId` and `mode`:

```json
{
    "requestId": "turn-2",
    "sessionId": "speaker-1",
    "clarificationId": "<id from clarification>",
    "text": "Wohnzimmer",
    "mode": "execute"
}
```

The caller supplies a distinct session ID for each independent conversation and keeps the clarification ID private to that conversation. `selection` may optionally contain the ID of a displayed option; spoken answers need only `text`. An answer that does not match repeats the question with the same ID. A clarification expires after five minutes; the next answer then receives a spoken expiry response. Whole-phrase replies such as `Stopp`, `Abbrechen`, `Stop`, or `Cancel` end the open question with `status: "cancelled"` and a spoken acknowledgement. The question itself does not announce cancellation words. Omitting `clarificationId` deliberately starts a new command and clears the old question for that session.

The React 19/MUI 9 Admin page provides a dashboard, device approvals and aliases, custom intents, background training, an analysis-first test lab, and diagnostics. Custom intents can be exported and imported as JSON; device approvals are excluded from imports. Admin 8 or later is required. After editing intents, start training to activate them.

## Trainingsbeispiele für eigene Intents

Ein eigener Intent braucht derzeit mindestens zwei gültige Beispiele auf Deutsch und zwei auf Englisch. Jedes Beispiel beschreibt **dieselbe Absicht**, aber mit einer anderen natürlichen Formulierung. Verwende kurze und längere Sätze, höfliche Varianten, andere Verben sowie wechselnde Geräte, Räume und Zahlen. Schreibe konkrete, realistische Befehle statt nur einzelne Stichwörter. Beispiele für Ein- und Ausschalten müssen klar unterscheidbar sein; ebenso Lese- und Schreibbefehle. Vermeide Formulierungen mit mehreren Aktionen, Ausnahmen oder Zeitangaben, die der Adapter noch nicht unterstützt.

Die Trainingsbeispiele steuern die **Intent-Erkennung**. Welches konkrete Gerät gemeint ist, bestimmen Gerätename, konfigurierte Aliase, Räume, Funktionen und Freigaben. Ein neues Wort für ein Gerät gehört deshalb in dessen Alias-Konfiguration. Nach Änderungen an eigenen Intents das Modell auf der Seite **Training** erneut trainieren und die Beispiele im **Testlabor** analysieren.

Ein Prompt zum Erzeugen kopierbarer Varianten:

```text
Erzeuge für meinen ioBroker-Intent "<INTENT-ID>" je 10 deutsche und 10 englische Trainingssätze.
Die beabsichtigte Aktion ist: <AKTION UND BEDEUTUNG>.
Beispiele, die dazugehören: <2–3 BEISPIELE>.
Nahe, aber andere Intents sind: <GEGENBEISPIELE>.

Alle Sätze müssen genau diese eine Absicht ausdrücken. Variiere Satzbau, Höflichkeit,
Verben, Geräte, Räume und bei Bedarf Zahlen/Werte. Vermeide mehrere Aktionen,
Zeitangaben, Ausnahmen, Negationen und mehrdeutige Aussagen. Verwende keine
fast identischen Kopien und keine Kommentare. Gib zwei Blöcke aus, "de" und "en",
mit genau einem Satz pro Zeile, sodass ich sie direkt in die Eingabefelder kopieren kann.
```

Prüfe die erzeugten Sätze vor dem Speichern: Ein Beispiel mit falscher Bedeutung verschlechtert die Klassifikation. Die spätere Erweiterung auf weitere Sprachen erfordert passende Trainingsdaten und Sprachmodelle.

Die Sprachliste und die benötigten NLP-Pakete stehen in `resources/languages.json`. Pro Sprache liegen Trainingsdaten unter `resources/training/`, Erkennungsmuster unter `resources/language-rules/`, Laufzeitantworten unter `resources/messages/` und Admin-Texte unter `src-admin/src/i18n/`. Beim Hinzufügen einer Sprache müssen diese Dateien, das passende NLP-Paket und Regressionstests ergänzt werden. Die Erkennungslogik enthält keine sprachspezifischen Wörter.

## Eigene Intents als JSON importieren

Die Importdatei ist UTF-8-JSON mit `schemaVersion: 1` und einem Array `intents`. Jeder Eintrag hat eine eindeutige `id` (Buchstabe am Anfang; danach Buchstaben, Ziffern, `_`, `-` oder `.`), `source: "user"`, `enabled`, Beispiele unter `utterances.de` und `utterances.en` sowie eine typisierte `action`. IDs mit `device.` am Anfang und `None` sind reserviert. Die Admin-Oberfläche verlangt bei Importen mindestens zwei Beispiele je derzeit unterstützter Sprache. Eine `response` enthält Antworttexte je Sprache; eine `capability` enthält eine Operation. Gerätefreigaben sind nicht Teil der Datei.

```json
{
    "schemaVersion": 1,
    "intents": [
        {
            "id": "user.greeting",
            "source": "user",
            "enabled": true,
            "utterances": {
                "de": ["Sag Hallo", "Begrüße mich"],
                "en": ["Say hello", "Greet me"]
            },
            "action": {
                "kind": "response",
                "response": { "de": "Hallo!", "en": "Hello!" }
            }
        }
    ]
}
```

Für eine Geräteaktion stattdessen beispielsweise `"action": { "kind": "capability", "operation": "turnOn" }` verwenden. Unterstützte Operationen sind `turnOn`, `turnOff`, `setValue`, `press`, `getState` und `getValue`. `press` löst einen freigegebenen booleschen `button`-State mit `true` aus. Die System-Intents für Helligkeit und Temperatur verwenden `setValue` und wählen den passenden numerischen State anhand von Name und Rolle. Nach dem Import auf **Training** ein neues Modell trainieren; der Import allein aktiviert die neuen Sätze nicht.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm ci --prefix src-admin
npm run check
npm run check:admin
npm run build
npm run lint
npm run format:check
npm test
npm run test:integration
```

TypeScript tests live under `test/`. The instance data directory contains `devices-v1.json`, `training/user-intents-v1.json`, `audit-v1.json`, and versioned files under `models/`. Corrupt registry or intent data stops the respective initialization. A damaged active NLP model falls back to the previous validated version when available.

See [implementation status](documentation/IMPLEMENTATION_STATUS.md) for scope, validation and open work.

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
   ### **WORK IN PROGRESS**

-->

### **WORK IN PROGRESS**

- first alpha release

## License

MIT. See [LICENSE](LICENSE).
