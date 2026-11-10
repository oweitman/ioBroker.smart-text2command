# ioBroker.nlp-control – Technische Spezifikation

**Version:** 1.0.0 (MVP)  
**Status:** Implementierungsvorgabe für Codex  
**Zielplattform:** ioBroker-Adapter auf Node.js / TypeScript  
**Sprachen:** Deutsch (`de`), Englisch (`en`)

## 1. Ziel und Abgrenzung

Ein eigenständiger ioBroker-Adapter interpretiert natürlichsprachliche Texte mit NLP.js und kann freigegebene ioBroker-Geräte schalten oder Zustände abfragen. Er stellt eine React/MUI-Admin-Oberfläche bereit. Integrationen nutzen zunächst `sendTo` und ioBroker-Datenpunkte; ein eigenes VIS-Widget, HTTP-Server, Sprachaufnahme und Cloud-LLM sind **nicht** Teil des MVP.

**Grundsätze:** lokale Verarbeitung; automatische Geräteerkennung, manuelle Freigabe; getrennte Intent-Erkennung und Geräteauflösung; Default Deny; nachvollziehbare Antworten; austauschbare NLP-Engine; persistente Konfiguration und Trainingsdaten.

### 1.1 MVP-Funktionen

- Deutsche und englische Befehle mit expliziter Sprache oder konfigurierter Standardsprache.
- System-Intents: `device.turnOn`, `device.turnOff`, `device.setLevel`, `device.setTemperature`, `device.getState`, `device.getValue`.
- Eigene Intents und Trainingsbeispiele; eigene Intents werden zunächst **nur** mit ausdrücklich konfigurierten, typisierten Aktionen oder Antwortvorlagen verknüpft, nicht mit frei ausführbarem JavaScript.
- Discovery von States, Channels, Devices, Raum- und Funktions-Enums; Capability-Zuordnung.
- Gerätefreigaben und Aliase im Admin; Analysemodus ohne Seiteneffekte.
- Einzelaktion je Anfrage, Rückfragen bei Mehrdeutigkeit oder fehlenden Angaben; Sitzungsverwaltung.
- `sendTo`-API und einfache State-Schnittstelle; Diagnose und Tests.

**Nicht im MVP:** komplexe Mehrfachaktionen, Zeitplanung, autonome Aktionen, HTTP-/MCP-API, Rollen-/Benutzeridentität aus beliebigen Nachrichten, VIS-spezifisches Widget, automatische Freigabe, beliebige Skriptausführung, LLM-Fallback.

## 2. Projektstruktur

```text
ioBroker.nlp-control/
├── src/
│   ├── main.ts
│   ├── api/{MessageRouter,RequestValidator,CommandController}.ts
│   ├── nlp/{NlpEngine,NlpJsProvider,TrainingManager,ModelRepository}.ts
│   ├── devices/{DeviceDiscovery,DeviceRegistry,CapabilityMapper,DeviceResolver,AliasManager}.ts
│   ├── commands/{CommandPlanner,PolicyEngine,CommandExecutor,ValueNormalizer}.ts
│   ├── dialog/{DialogManager,SessionStore}.ts
│   ├── storage/{ConfigurationRepository,AuditRepository}.ts
│   └── types/{api,device,command,training}.ts
├── admin/src/{pages,components,services,types}/
├── resources/training/{de,en}.json
├── test/{unit,integration,fixtures}/
├── io-package.json
├── package.json
├── tsconfig.json
└── README.md
```

Adapter-Lifecycle und ioBroker APIs nur in `main.ts` und einer dünnen Infrastruktur-Bridge verwenden. Kernlogik wird durch Dependency Injection und Mock-Interfaces isoliert. Versionen der Bibliotheken anhand der zum Implementierungszeitpunkt unterstützten ioBroker-Adapter-Toolchain festlegen, nicht unbesehen die neuesten Major-Versionen installieren.

## 3. Verarbeitungspipeline

```text
Client → RequestValidator → NLP Engine → Entity Extraction
       → DeviceResolver → DialogManager → CommandPlanner
       → PolicyEngine → CommandExecutor → ResultFormatter → Client
```

1. Eingabe normalisieren und begrenzen; Sprache bestimmen.
2. NLP-Intent und Konfidenz ermitteln; Gerätebezeichnungen und Werte separat extrahieren.
3. Kandidaten anhand freigegebener Geräte, Aliase, Raum, Funktion und Capability auflösen.
4. Bei fehlenden Angaben oder mehreren ähnlich plausiblen Treffern Rückfrage erzeugen.
5. Typisierten Aktionsplan aufbauen und **vor jedem Schreibzugriff** validieren.
6. Bei `analyze` nur Plan und Diagnose zurückgeben, ohne zu schreiben.
7. Bei `execute` über ioBroker schreiben oder lesen; Ergebnis als `accepted`, `confirmed`, `rejected` oder `failed` melden.

Ein erfolgreiches `setState(..., ack:false)` bedeutet zunächst nur, dass der Befehl übergeben wurde. Eine Bestätigung des physischen Zustands erfordert geeignete Rückmelde-States und eine zeitlich begrenzte Prüfung. Kein generisches `confirmed` ohne entsprechende Evidenz.

## 4. Typisierte Datenmodelle

```typescript
type Language = 'de' | 'en';
type CapabilityKind = 'onOff' | 'brightness' | 'temperatureSetpoint' | 'readTemperature' | 'position';
type ValueKind = 'boolean' | 'number' | 'string';

interface Capability {
  kind: CapabilityKind;
  stateId: string;
  readStateId?: string;
  readable: boolean;
  writable: boolean;
  valueKind: ValueKind;
  min?: number;
  max?: number;
  unit?: string;
  enumValues?: Array<string | number>;
  mapping?: { on?: unknown; off?: unknown; scale?: number; offset?: number };
}

interface DeviceRecord {
  id: string;                       // stabile interne ID
  sourceObjectId: string;
  displayName: string;
  roomIds: string[];
  functionIds: string[];
  aliases: Partial<Record<Language, string[]>>;
  discoveredCapabilities: Capability[];
  approvedCapabilities: CapabilityKind[];
  enabled: boolean;                 // Default false
  discoveryFingerprint: string;
  lastSeenAt: string;
  status: 'available' | 'missing' | 'needsReview';
}

interface IntentDefinition {
  id: string;
  source: 'system' | 'user';
  enabled: boolean;
  utterances: Partial<Record<Language, string[]>>;
  action?: { kind: 'capability' | 'response'; capability?: CapabilityKind; response?: Partial<Record<Language,string>> };
}

interface CommandRequest {
  requestId: string;
  sessionId?: string;
  language?: Language;
  text: string;
  mode: 'analyze' | 'execute';
}

interface Candidate { deviceId: string; score: number; reasons: string[] }
interface PlannedAction { deviceId: string; capability: CapabilityKind; operation: 'read' | 'write'; value?: boolean | number | string }
interface ActionResult { deviceId: string; stateId: string; status: 'planned' | 'accepted' | 'confirmed' | 'rejected' | 'failed'; message?: string }
interface CommandResult {
  requestId: string;
  status: 'success' | 'partial' | 'clarification' | 'rejected' | 'error';
  intent?: string;
  confidence?: number;
  language: Language;
  response: string;
  candidates?: Candidate[];
  actions?: ActionResult[];
  clarification?: { key: 'device' | 'room' | 'value' | 'confirmation'; options?: string[] };
  modelVersion?: string;
  durationMs?: number;
}
```

**Regeln:** Konfidenz ist eine Modellschätzung, keine garantierte Wahrscheinlichkeit. Keine Ausführung allein aufgrund einer hohen Konfidenz. Gerät und Capability müssen separat eindeutig identifiziert und autorisiert sein. Exakte Namen und Aliase höher gewichten als Fuzzy-Matches; Gleichstand oder geringer Score-Abstand führt zur Rückfrage.

## 5. NLP.js und Training

### 5.1 Engine-Abstraktion

```typescript
interface NlpEngine {
  load(model: Uint8Array | string): Promise<void>;
  train(data: IntentDefinition[], languages: Language[]): Promise<Uint8Array | string>;
  analyze(text: string, language: Language): Promise<{
    intent: string | null;
    confidence: number;
    entities: Array<{ type: string; value: string | number; start?: number; end?: number }>;
    alternatives?: Array<{ intent: string; confidence: number }>;
  }>;
}
```

`NlpJsProvider` kapselt konkrete NLP.js-Paket-APIs. Training und Inferenz dürfen nicht direkt in UI-Komponenten stattfinden. Im MVP werden explizit `de` und `en` unterstützt; kein stilles Umschalten auf andere Sprachen. Die Sprache wird im Request oder aus der Adapterkonfiguration bestimmt. Eine automatische Sprachdetektion ist optional und muss testbar sein.

### 5.2 Trainingsdaten

Versioniertes JSON-Format mit `schemaVersion`, `language`, `intents` und `utterances`. System-Intents sind mitgelieferte Ausgangsdaten, benutzerdefinierte Beispiele liegen getrennt und überschreiben nicht die Ressourcen-Dateien. Trainingsbeispiele umfassen positive Formulierungen, Negativ-/Out-of-scope-Beispiele und unterschiedliche Satzstellungen.

**Training:** Entwurf speichern → JSON-Schema prüfen → separates Modell trainieren → Regressionstests auf festen Beispielsätzen → Modell als neue Version speichern → atomar aktivieren. Bei Fehler bleibt die vorherige Version aktiv. Modellversion, Trainingsdaten-Hash, Engine-Version, Zeitpunkt und Testresultate speichern. Trainieren nicht bei jedem Request. Modellinitialisierung beim Start: letztes gültiges Modell laden; falls nicht vorhanden, Basismodell trainieren. Ein Training darf den Event Loop nicht dauerhaft blockieren; bei Bedarf Worker Thread oder Child Process verwenden.

### 5.3 Entity-Auflösung

- NLP.js klassifiziert die Absicht; ein separater Entity-Parser erkennt Zahlen, Prozentangaben, Temperaturen, Räume, Gerätephrasen und Negationen.
- Numerische Werte lokalisiert parsen (`21,5` und `21.5`), Einheit prüfen und erst danach auf die Ziel-Capability abbilden.
- DeviceResolver arbeitet gegen den aktuellen Gerätekatalog, nicht gegen einen festen NLP-Vokabularsatz.
- Nutzer-Aliase müssen ohne Modell-Retraining wirksam werden.
- Ausdrücke wie „alle“, „außer“, „morgen“ oder mehrere Aktionen werden im MVP als nicht unterstützt erkannt und **nicht** stillschweigend teilweise ausgeführt.

## 6. Automatische Geräteerkennung

### 6.1 Discovery

Beim Start `device`-, `channel`- und `state`-Objekte einlesen, `common`-Metadaten sowie `enum.rooms.*` und `enum.functions.*` auswerten. Zuordnungen über Elternobjekte berücksichtigen. Änderungen an Objekten und Enums abonnieren; Re-Discovery debouncen und inkrementell durchführen. Keine unnötige permanente Vollabfrage.

**Kandidaten:** primär `common.role`, `common.type`, `common.read`, `common.write`, `common.min`, `common.max`, `common.unit`, `common.states`; außerdem Elternobjekte, Enum-Zuordnung und optional adapter-spezifische Mapping-Profile. Fehlende oder widersprüchliche Metadaten führen zu `needsReview`, nicht zu blindem Schreiben.

**Capability-Mapping (Beispiele, nicht abschließend):**

| ioBroker-Rolle / Merkmale | Capability | Voraussetzung |
|---|---|---|
| `switch`, boolescher schreibbarer State | `onOff` | verifiziertes On/Off-Mapping |
| `level.dimmer`, numerisch | `brightness` | Min/Max oder explizite Skalierung |
| `level.temperature` | `readTemperature` | lesbarer Messwert |
| geeigneter Sollwert-State | `temperatureSetpoint` | eindeutig als Sollwert identifiziert, schreibbar |
| `level.blind` o. ä. | `position` | Richtung/Skala explizit geklärt |

Nicht aus `level.temperature` allein auf einen schreibbaren Thermostat-Sollwert schließen. Eine Capability kann verschiedene Lese- und Schreib-States besitzen. Alias-Objekte und gerätespezifische Mappings sind auf Zielreferenzen und Wertebereich zu prüfen.

### 6.2 Freigaben und Änderungen

Discovery erstellt neue Geräte mit `enabled:false` und leerer `approvedCapabilities`-Liste. Benutzer gibt Gerät **und** erlaubte Fähigkeiten explizit frei. Aliasänderungen, Raumwechsel und kosmetische Metadatenänderungen erhalten die Freigabe. Änderungen an State-ID, Datentyp, Schreibbarkeit, Wertemapping oder sicherheitsrelevanter Capability setzen diese Capability auf `needsReview` und deaktivieren die Ausführung bis zur erneuten Freigabe. Entfernte Geräte bleiben als `missing` für Diagnose und spätere Wiedererkennung erhalten. Freigaben niemals durch automatische Discovery überschreiben.

## 7. API und Datenpunkte

### 7.1 `sendTo`-Nachrichten

- `processText`: `{requestId, sessionId?, language?, text, mode}` → `CommandResult`
- `listDevices`: paginierte, gefilterte Geräteübersicht für Admin
- `updateDevice`: Aliase, `enabled`, freigegebene Capabilities; Eingaben validieren
- `listIntents`, `saveIntent`, `deleteIntent`: Trainingsdatenverwaltung
- `trainModel`: Training starten, Job-ID zurückgeben
- `getTrainingStatus`: Jobstatus, Modellversion, Validierungsergebnisse
- `getDiagnostics`: Modellstatus, Discovery-Zähler, letzte Fehler

Nachrichten werden über die ioBroker-Adapter-Message-API verarbeitet. `requestId` ist für Korrelation und Duplikaterkennung gedacht; sie ist **keine** Autorisierung. Der Aufruferkontext muss durch einen vertrauenswürdigen Transport/Adapterzugriff gesichert sein. Nicht vertrauenswürdige Clients dürfen keine Administrationsbefehle erhalten.

**Beispiel:**

```json
{
  "command": "processText",
  "message": {
    "requestId": "req-1001",
    "sessionId": "vis-livingroom",
    "language": "de",
    "text": "Schalte die Stehlampe ein",
    "mode": "analyze"
  }
}
```

### 7.2 State-Schnittstelle

| State unter `nlp-control.0` | Typ | Bedeutung |
|---|---|---|
| `input.text` | string, write | Eingabe für **Analysemodus** |
| `output.response` | string, read | letzte Antwort |
| `output.result` | string, read | JSON des letzten Ergebnisses |
| `output.status` | string, read | `idle`, `processing`, `done`, `error` |
| `info.modelStatus` | string, read | `loading`, `ready`, `training`, `error` |
| `info.deviceCount` | number, read | erkannte Geräte |

**Sicherheitsentscheidung:** `input.text` löst im MVP nur `analyze` aus, **keine Schreibaktionen**. Ausführung erfolgt ausschließlich über einen kontrollierten `sendTo`-Pfad. Da ioBroker-State-Zugriffe und `sendTo` nicht automatisch dieselbe Benutzeridentität oder ACL-Granularität garantieren, darf ein ungeschützter VIS-Zugang nicht durch bloße Kenntnis einer Session-ID Schreibrechte erlangen. Eine spätere sichere Ausführung aus VIS erfordert eine authentifizierte, autorisierte Bridge oder ausdrücklich vertrauenswürdige Deployment-Konfiguration.

Bei gleichzeitigen State-Eingaben ist `output.*` nur ein globaler Letztwert; Mehrbenutzerfähigkeit ausschließlich über `sendTo` und Request-IDs. State-Schreibtrigger nur bei `ack:false`; eigene Ausgabestates mit `ack:true` setzen. Eingabetext begrenzen (Standard 1000 Zeichen), Ergebnisgröße begrenzen, Fehler strukturiert zurückgeben.

## 8. Dialoge

`SessionStore` hält pro Session einen begrenzten Kontext: offene Absicht, erkannte Werte, Kandidaten, Ablaufzeit und letzten Bezug. Standard-TTL 5 Minuten, maximale Sessions konfigurierbar. Keine langfristige Speicherung persönlicher Chattexte im MVP. Nach Ablauf oder Adapterneustart muss die Eingabe erneut vollständig gestellt werden. Rückfragen dürfen keine impliziten Schreibrechte erzeugen. Bestätigungstokens müssen serverseitig gebunden, einmalig und kurzlebig sein; im MVP sind kritische Aktionsarten standardmäßig gesperrt.

## 9. Persistenz

- `native`-Konfiguration: Sprache, Schwellenwerte, Discovery-Optionen, Logging, Policy-Defaults; keine großen Binärmodelle.
- Adaptereigene persistente Dateien über die dafür vorgesehenen ioBroker-Adapter-Datei-/Datenverzeichnisse: versionierte Trainingsdaten, Modelle, Geräte-Overrides, Freigaben und Audit-Metadaten.
- Trennung zwischen rekonstruierbarem Discovery-Cache und nicht rekonstruierbaren Benutzerfreigaben/Aliasen.
- Atomare Dateiersetzung (temporäre Datei → Validierung → Rename, soweit vom Storage unterstützt), Checksummen und Backups vor Migrationen.
- Schema-Version in jeder gespeicherten Datenstruktur; explizite Migrationen mit Rollback-/Fehlerstrategie.
- Keine Speicherung sensibler Zugangsdaten in Trainingssätzen oder Logs; konfigurierbare Audit-Aufbewahrung.

## 10. Sicherheit und Ausführungsregeln

1. **Default Deny:** neue Geräte und Capabilities nicht freigegeben.
2. **Keine Arbitrary Execution:** kein `eval`, keine Shell, keine dynamischen State-IDs aus Rohtext, keine beliebigen Skripte aus Benutzer-Intents.
3. **Schreib-Whitelist:** Ziel-State muss aus der genehmigten Capability stammen, aktuell existieren und schreibbar sein.
4. **Validierung zur Ausführungszeit:** Datentyp, Einheit, Grenzwerte, Enum-Werte und Mapping unmittelbar vor dem Schreiben erneut prüfen.
5. **Mehrdeutigkeit:** Rückfrage oder Ablehnung; niemals Zufallsauswahl.
6. **Schwellwerte:** niedrige Intent-Konfidenz oder geringer Abstand zwischen Kandidaten → keine Ausführung. Konkrete Werte empirisch anhand Testdaten kalibrieren.
7. **Kritische Funktionen:** Schlösser, Alarme, Garagentore, sicherheitsrelevante Aktoren und unbekannte Rollen standardmäßig gesperrt; explizite Policy-Erweiterung erst nach gesondertem Sicherheitsdesign.
8. **Rate Limits und Limits:** pro Client/Session, Textlänge, gleichzeitige Trainingsjobs, maximale Discovery-Menge und Ausführungs-Timeouts.
9. **Idempotenz:** Request-IDs für begrenzte Zeit gegen versehentliche doppelte Ausführung schützen; keine unbegrenzte Exactly-Once-Garantie.
10. **Audit:** Zeit, Request-ID, Intent, Geräte-ID, Policy-Entscheidung, Ausführungsergebnis und Fehlercode; Rohtext optional und standardmäßig nicht dauerhaft protokollieren.

`analyze` muss nachweisbar frei von Schreibseiteneffekten sein. Ein hoher NLP-Score ist **niemals** eine Sicherheitsfreigabe.

## 11. Admin-Oberfläche (React/MUI)

Seiten:

1. **Dashboard:** Modellstatus, erkannte/freigegebene Geräte, letzte Fehler.
2. **Geräte:** Discovery-Ergebnisse, Filter nach Raum/Capability, Aliasverwaltung, Freigabe je Capability, Warnung bei Änderungen.
3. **Intents:** System- und Benutzer-Intents, Trainingsbeispiele für `de`/`en`, Aktionstypen, Validierung.
4. **Training:** Start, Fortschritt, Modellversionen, Regressionsergebnisse, Rollback.
5. **Testlabor:** Texteingabe, Sprache, Intent-Ranking, extrahierte Entitäten, Gerätekandidaten, Policy-Entscheidung, geplanter State-Zugriff; Standard `analyze`.
6. **Einstellungen/Diagnose:** Grenzwerte, Modell-/Discovery-Status, Fehler, Export/Import.

Admin-Aktionen über vorhandene ioBroker-Admin-Mechanismen, nicht über einen zusätzlichen offenen HTTP-Port. Training und Discovery müssen asynchron mit Statusmeldungen erfolgen; UI darf nicht blockieren.

## 12. Tests und Akzeptanzkriterien

### 12.1 Unit-Tests

- Zahlenparser (`21`, `21,5`, `40 %`), Sprache, Negation und unsupported syntax.
- Intent-Training und Inferenz mit festen deutschen und englischen Fixtures.
- Geräteauflösung: exakte Aliase, Raumkontext, doppelte Namen, Fuzzy-Konflikte.
- Capability-Mapping: read-only, Soll-/Istwert, Boolean-Mapping, ungültige Bereiche.
- Policy: Default Deny, fehlende Freigabe, Capability-Änderung, kritische Rolle, unzulässige State-ID.
- Dialog: Rückfrage, TTL, abgelaufene Session.
- Modellpersistenz: Versionierung, beschädigtes Modell, fehlgeschlagenes Training, Rollback.

### 12.2 Integrationstests

- ioBroker-Mock mit Objects/States/Enums; Objektänderungen aktualisieren Discovery.
- `sendTo`-Request → Analyse → Plan → kontrollierter `setState`-Mock.
- Analysemodus und State-Eingabe erzeugen **null** Schreibzugriffe auf Geräte-States.
- Ausführung nur für freigegebene Capability, exakt ein Schreibzugriff für einfachen Schaltbefehl.
- `ack:false` bei Gerätekommandos; `ack:true` bei Adapter-Ausgaben.
- Adapterneustart erhält Aliase, Freigaben und aktives Modell.
- Zwei parallele Requests bleiben anhand der Request-IDs korrekt zugeordnet.

### 12.3 Abnahmekriterien

- Deutsch und Englisch mit je mindestens 20 validierten positiven und geeigneten negativen Testbeispielen pro Kern-Intent (als Startwert, bei Bedarf erweitern).
- Kein Schreibzugriff bei unklarem Intent, unklarem Gerät, fehlender Freigabe oder ungültigem Wert.
- Neue Geräte werden ohne Neustart erkannt, aber nicht freigegeben.
- Benutzer-Aliase greifen ohne Retraining.
- Ein fehlgeschlagenes Training verändert das aktive Modell nicht.
- Ergebnisstatus unterscheidet angenommene von bestätigten Befehlen.
- Dokumentierte manuelle Testmatrix für mindestens zwei unterschiedliche Geräteadapter.

## 13. Implementierungsreihenfolge für Codex

**Phase 0 – Repository und Standards**
- Adapter-Template, TypeScript, Lint/Format, CI, Tests, `io-package.json`, Grundgerüst.
- Typen, Fehlercodes und Schema-Validierung definieren.

**Phase 1 – Geräte-Discovery und Policy**
- Object-/Enum-Reader, Registry, Capability-Mapping, Freigaben und Persistenz.
- Unit- und Integrationstests, insbesondere Default Deny.

**Phase 2 – NLP-Kern**
- `NlpEngine`-Interface, NLP.js-Provider, Basistraining `de`/`en`, Entity-Parser, Resolver.
- Feste Regressionstests, ModelRepository und atomarer Modellwechsel.

**Phase 3 – Command Pipeline und API**
- Planner, PolicyEngine, Executor, DialogManager, `sendTo`-API, Analyse-States.
- Audit, Idempotenz, Timeouts, Fehlerbehandlung, Integrationstests.

**Phase 4 – Admin-Oberfläche**
- Geräteverwaltung und Freigaben, Intent-Editor, Training, Testlabor, Diagnose.
- Tests für Formvalidierung und Adapterkommunikation.

**Phase 5 – Stabilisierung und Release**
- E2E-Tests mit ioBroker-Testinstanz, Performance-/Speichertests, Migrationstest, Dokumentation, Sicherheitsreview, Release-Checkliste.

Nach jeder Phase: Tests ausführen, Dokumentation aktualisieren, Commit mit nachvollziehbarem Scope. Keine späteren Phasen beginnen, solange Sicherheits- oder Datenintegritätstests der vorherigen Phase fehlschlagen.

## 14. Codex-Arbeitsauftrag

> Implementiere `ioBroker.nlp-control` gemäß dieser Spezifikation in kleinen, testbaren Phasen. Beginne mit einer Bestandsaufnahme des Repositories und der aktuellen ioBroker-Adapter-Toolchain. Erstelle zunächst eine kurze Umsetzungsplanung mit konkreten Dateien, Abhängigkeiten und Tests. Implementiere anschließend Phase 0 und Phase 1 vollständig, einschließlich Unit- und Integrationstests. Vermeide nicht spezifizierte externe Services. Achte auf Default-Deny, die Trennung von Analyse und Ausführung sowie die vollständige Persistenz der Benutzerfreigaben. Dokumentiere Abweichungen und offene Architekturentscheidungen, statt sie stillschweigend zu treffen. Führe alle verfügbaren Tests aus und melde Ergebnisse und verbleibende Risiken.

## 15. Entscheidungen für spätere Versionen

- Authentifizierte VIS-Ausführung über geeignete Bridge und per-User-Rechte.
- Komplexe Befehle, Mehrfachaktionen, Gruppen und Ausnahmen.
- Zeitsteuerung, Szenen und relative Wertänderungen.
- Weitere Sprachen und optionale automatische Sprachdetektion.
- Austauschbarer LLM-Provider (z. B. Ollama) mit identischer Policy-/Executor-Pipeline.
- Externe API/MCP erst mit separatem Authentifizierungs-, Autorisierungs- und Netzwerkdesign.
