# Konfigurierte `sendTo`-Aktion für eigene Intents

**Status:** implementierte Erweiterung. Diese Spezifikation ergänzt die bestehende [Adapterspezifikation](ioBroker.smart-text2command_SPECIFICATION.md). Die [eingehende `processText`-API](SENDTO_API.md) bleibt der Aufrufweg für andere Adapter. Hier geht es um einen *ausgehenden* `sendTo`-Aufruf, den ein erkannter eigener Intent auslöst.

## 1. Konfiguration im Intent-Editor

Ein eigener Intent erhält neben Geräteaktion und Antwortvorlage den Aktionstyp **`sendTo`**. Der Admin konfiguriert:

- eine feste Empfängerinstanz, beispielsweise `javascript.0`;
- einen festen Befehl, beispielsweise `toScript`;
- eine JSON-Nachricht mit festen Werten und Parameterplatzhaltern;
- pro Parameter einen eindeutigen Namen, den Typ `string` oder `number` und eine Rückfrage pro unterstützter Sprache;
- falls Parameter vorhanden sind: pro Sprache Erkennungsmuster, die Textstellen den benannten Parametern zuordnen.

Die vorhandenen Trainingsbeispiele erkennen weiterhin den **Intent**. Die Erkennungsmuster lesen erst danach dessen **Parameter** aus dem Text. Empfängerinstanz und Befehl sind keine Parameter und können durch einen gesprochenen Befehl nicht geändert werden. Die Konfiguration ist ausschließlich über die bestehenden Admin-Berechtigungen änderbar.

Beispiel einer Intent-Konfiguration:

```json
{
  "id": "sendeWert",
  "enabled": true,
  "utterances": {
    "de": ["Sende einen Wert", "Übermittle den Wert"],
    "en": ["Send a value", "Transmit the value"]
  },
  "action": {
    "kind": "sendTo",
    "instance": "javascript.0",
    "command": "toScript",
    "payloadTemplate": {
      "script": "script.js.common.ZielSkript",
      "message": "meinBefehl",
      "data": {
        "wert": { "$param": "wert" },
        "text": { "$param": "text" }
      }
    },
    "parameters": [
      {
        "name": "wert",
        "type": "number",
        "prompt": { "de": "Bitte gib den Wert an.", "en": "Please provide the value." }
      },
      {
        "name": "text",
        "type": "string",
        "prompt": { "de": "Bitte gib den Text an.", "en": "Please provide the text." }
      }
    ],
    "extractionPatterns": {
      "de": ["Sende Wert {wert} mit Text {text}", "Übermittle den Wert {wert} mit Text {text}"],
      "en": ["Send value {wert} with text {text}", "Transmit value {wert} with text {text}"]
    }
  }
}
```

Bei `javascript.0` haben `command` und `payloadTemplate.message` unterschiedliche Aufgaben: `command` ist der Adapterbefehl **`toScript`**; `payloadTemplate.message` ist der Name, den das Zielskript mit `onMessage(...)` empfängt. Groß- und Kleinschreibung des Skriptbefehls müssen übereinstimmen. `payloadTemplate.script` muss die tatsächliche Objekt-ID des Zielskripts enthalten, beispielsweise `script.js.sendto`.

Das JSON-Feld wird als **strenges JSON** eingegeben: doppelte Anführungszeichen für Schlüssel und Strings, keine Kommentare. `{"$param":"wert"}` bezeichnet genau einen Platzhalter. Das Objekt darf dafür keine weiteren Schlüssel haben. Der Platzhalter kann auch in verschachtelten Objekten oder Arrays stehen; er wird als ganzer JSON-Wert durch den erkannten Wert ersetzt. Damit bleibt eine Zahl eine Zahl und ein String ein String. Eine Einbettung von Platzhaltern *innerhalb* eines Strings ist in Version 1 nicht vorgesehen. Feste JSON-Werte dürfen alle gültigen JSON-Typen nutzen.

**Nachricht ohne Parameter:** Enthält das JSON nur feste Werte, bleibt `parameters` leer. `extractionPatterns` kann entfallen; im Intent-Editor wird das Feld dann ausgeblendet. Die Trainingsbeispiele allein bestimmen, wann die feste Nachricht gesendet wird. Die Zahlen und Strings im JSON werden unverändert übergeben.

Beim Speichern werden JSON-Syntax, eindeutige Parameternamen, unterstützte Parametertypen und alle Verweise geprüft. Jeder Platzhalter muss einen definierten Parameter haben; jeder definierte Parameter muss im Template vorkommen und durch mindestens ein Erkennungsmuster oder eine Rückfrage erreichbar sein. Ungültige Konfigurationen werden mit einem konkreten Feldfehler abgewiesen. Die Sprachliste stammt aus der vorhandenen Sprachkonfiguration; Rückfragen und Muster sind je aktivierter Sprache zu pflegen, ohne Sprachwörter in der Programmlogik fest zu codieren.

## 2. Erkennung und Rückfragen

Nach sicher erkannter Intent-ID werden passende Muster für die Anfragesprache geprüft. `{wert}` und `{text}` erfassen die jeweils zugehörigen Textabschnitte zwischen den festen Musterteilen. Auch mehrteilige String-Werte sind möglich. Für `number` wird ein endlicher Zahlenwert in der Sprache der Anfrage akzeptiert, beispielsweise `42`, `42,5` auf Deutsch oder `42.5` auf Englisch. Ein String muss nach dem Trimmen mindestens ein Zeichen enthalten. Bei mehrdeutiger Zuordnung wird nachgefragt, statt einen Wert zu raten.

Fehlt ein Parameter oder ist sein Wert ungültig, antwortet der Adapter mit der für ihn konfigurierten Rückfrage und einer `clarificationId`. Bereits erkannte Parameter bleiben für diese offene Rückfrage erhalten. Der Aufrufer sendet die Antwort über die bestehende `processText`-API mit derselben `sessionId` und der erhaltenen `clarificationId`; der Adapter ergänzt damit nur die offene Frage. Fehlen mehrere Parameter, werden sie nacheinander abgefragt. Die bestehenden Regeln für Ablaufzeit, Abbruch, Absenderbindung und getrennte Sitzungen mehrerer Nutzer gelten ebenso. Der API-Rückfrageschlüssel wird dafür um `parameter` erweitert; die Parameter-ID wird in der strukturierten Rückfrage mitgegeben.

Eine neue Eingabe ohne passende `clarificationId` ist wie bisher eine neue Anfrage. Passt die Antwort nicht zur offenen Parameterfrage, bleibt die Rückfrage bestehen oder die Eingabe wird nach den bestehenden Gesprächsregeln als neue Anfrage interpretiert. Eine ungültige Zahl darf niemals stillschweigend als `0` übernommen werden.

## 3. Ausführung und Antwort

`mode: "analyze"` darf **keinen** ausgehenden `sendTo`-Aufruf auslösen. Es zeigt Intent, erkannte beziehungsweise fehlende Parameter und einen geplanten Aufruf mit Instanz und Befehl zur Diagnose an. `mode: "execute"` sendet genau einmal, nachdem alle Parameter eindeutig und gültig sind. Das Template wird rekursiv aufgelöst und als JSON-Objekt über die ioBroker-Adapter-Message-API an die fest konfigurierte Instanz geschickt. Es wird weder JavaScript ausgewertet noch eine Shell gestartet. Automatische Wiederholungen sind wegen möglicher Seiteneffekte ausgeschlossen.

Der Empfänger antwortet über den ioBroker-Callback mit diesem versionierten **Nachrichtenobjekt**:

```json
{
  "version": 1,
  "status": "success",
  "text": "Der Befehl wurde ausgeführt."
}
```

`status` ist in Version 1 `success` oder `error`. `text` ist ein nicht leerer, direkt ausgebbarer oder sprechbarer String. Bei `error` enthält er die vom Empfänger formulierte Fehlermeldung. Der Adapter prüft Version, Status und Text und übernimmt den Text in `CommandResult.response`; das Testlabor zeigt ihn im Chat. Der globale Ausgabe-Datenpunkt wird nur beim vorhandenen State-Eingabepfad aktualisiert, nicht bei `sendTo`-Aufrufen mit getrennten Sitzungen. `success` ergibt einen erfolgreichen CommandResult, `error` einen Fehlerstatus. Da für diese Aktion kein Gerätedatenpunkt beteiligt ist, darf die Ergebnisstruktur keine erfundene Geräte- oder State-ID voraussetzen.

Ein `sendTo`-Callback ist erforderlich. Bleibt er aus, ist die Instanz nicht erreichbar oder ist das Antwortobjekt ungültig beziehungsweise hat eine unbekannte Version, gibt der Adapter einen strukturierten Fehler mit sprachabhängigem, sprechbarem Text aus. Ein fehlender Callback gilt **nicht** als Erfolg. Als initialer Standard gilt ein Ausführungs-Timeout von 20 Sekunden; die genaue Konfigurierbarkeit kann später ergänzt werden. Das Ergebnis wird der ursprünglichen `requestId` zugeordnet. Die vorhandene begrenzte Duplikaterkennung für Request-IDs gilt weiter; sie ist keine Garantie für genau einmalige Ausführung über Prozessneustarts hinweg.

Im **Testlabor** enthält auch das Ausführungsergebnis unter `analysis.sendTo` die rohe Callback-Antwort (`rawCallback`) und den daraus gelesenen Nachrichteninhalt (`message`). Diese technischen Angaben werden mit der Session-Historie gespeichert. Bei einem Transportfehler steht dort `transportError`. Die Diagnose ist auf 8192 Zeichen je Callback begrenzt; andere `processText`-Aufrufer erhalten diese Ausführungsdetails nicht.

Für ein JavaScript-Zielskript entspricht die Antwort konzeptionell:

```javascript
onMessage('meinBefehl', (data, callback) => {
    callback({ version: 1, status: 'success', text: 'Der Befehl wurde ausgeführt.' });
});
```

Die Form des ioBroker-Transport-Callbacks kann einen Umschlag enthalten; der Adapter wertet dessen **Nachricht** als obiges Antwortobjekt aus. Der aufrufende Adapter erhält wie bisher ein `CommandResult` als Antwort auf `processText`.

## 4. Grenzen und Abnahmekriterien

Die neue Aktion erlaubt nur einen vom Admin festgelegten Empfänger, Befehl und JSON-Nachrichtenrahmen. Sprachtext kann ausschließlich die ausdrücklich definierten Parameter füllen. Das Skriptziel im Beispiel ist ein **fester Wert** im Template. Dynamische Skript-IDs, freie Codeausführung und Betriebssystem-`exec` gehören nicht zu dieser Erweiterung. Für einen bewusst konfigurierten Empfänger mit Seiteneffekten ist der Admin verantwortlich; diese Aktion führt keine zusätzliche Berechtigungsschicht über ioBroker hinaus ein.

Die Umsetzung ist abgenommen, wenn mindestens folgende Fälle unter `/test` geprüft sind:

- gültige und ungültige JSON-Templates sowie fehlende, unbekannte oder doppelte Parameter;
- typsichere Ersetzung von String und Zahl auch in verschachtelten Objekten/Arrays;
- Erkennung eines vollständigen Musters, einer fehlenden oder ungültigen Zahl und eines mehrteiligen Strings;
- Rückfragen mit Fortsetzung und getrennte Gespräche bei unterschiedlichen Absendern/Sessions;
- keine ausgehende Nachricht im Analysemodus und genau ein Aufruf im Ausführungsmodus;
- erfolgreiche und fehlerhafte Empfängerantwort sowie Timeout, fehlender Callback und fehlerhafte oder unbekannte Antwortversion;
- sprechbarer Antworttext im `CommandResult` und im Testlabor-Chat.
