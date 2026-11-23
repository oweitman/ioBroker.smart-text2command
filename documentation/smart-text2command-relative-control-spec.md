# Technische Spezifikation: Relative Steuerung und Farbsteuerung für ioBroker.smart-text2command

**Status:** Implementierungsvorlage für Codex  
**Zielprojekt:** https://github.com/oweitman/ioBroker.smart-text2command  
**Stand:** 22.11.2026  
**Charakter:** Erweiterung des bestehenden Adapters, kein Rewrite

## 1. Ziel und Leitprinzipien

Der Adapter soll natürlichsprachliche Befehle für relative Wertänderungen und Farbsteuerung unterstützen, ohne dass Benutzer für jedes Gerät und jedes Steuerwort eigene Regeln anlegen müssen.

Beispiele:

- „Mach das Wohnzimmerlicht etwas heller.“
- „Stell die Heizung deutlich wärmer.“
- „Mach das Licht wärmer.“ (Farbtemperatur statt Raumtemperatur)
- „Mach den Fernseher leiser.“
- „Fahre die Rollläden ein Stück weiter herunter.“
- „Stelle die Wohnzimmerlampe auf Türkis.“
- „Mach das Blau kräftiger.“
- „Stelle den Ventilator eine Stufe höher.“

**Kernprinzip:** Sprache erkennen → Ziel und semantische Capability bestimmen → Intensität auflösen → Geräteprofil und Wertebereich anwenden → sicheren Zielwert berechnen → über den bestehenden Adapter-Ausführungspfad schreiben.

Die Erkennung darf nicht unmittelbar feste Zahlenwerte an Wörter koppeln. „Etwas wärmer“ bedeutet bei einer Heizung etwas anderes als bei einer LED mit einstellbarer Farbtemperatur.

### Nichtziele für die erste Version

- Keine verpflichtende LLM- oder Cloud-Abhängigkeit.
- Kein selbstlernendes Verhalten oder automatische Änderungen der Schrittweiten anhand der Nutzung.
- Keine komplette Umgestaltung der bestehenden NLP-, Gerätefreigabe- oder VIS-Schnittstellen.
- Keine ungesicherte Ausführung auf beliebigen ioBroker-States.
- Keine verbindliche Unterstützung jedes proprietären Farbschemas; nicht erkannte Formate werden sicher abgelehnt oder über explizite Erweiterungen unterstützt.

## 2. Vorarbeit: Repository-Analyse (verpflichtend)

Vor jeder Änderung muss Codex den aktuellen Repository-Stand untersuchen und dokumentieren:

1. Adapterstruktur, JavaScript-/TypeScript-Stand, vorhandene Tests, Build-/Lint-Konventionen.
2. Aktuelle NLP-/Intent-Erkennung, Sprachdateien (Deutsch/Englisch), Parser und vorhandene Trainingsbeispiele.
3. Device Discovery, Freigabemodell, Alias-/Raum-/Geräteauflösung und vorhandene Capability-Metadaten.
4. Datenmodelle und Konfigurationsspeicherung in Admin UI und Adapter.
5. Aktuelle Schreib-/Befehlsausführung, Validierung, `setState`/`sendTo`, VIS-Integration und Logging.
6. Bereits existierende relative Operationen, Farben, Dimmer, Temperatur und andere verwandte Funktionen, um Doppelimplementierungen zu vermeiden.

**Vorgabe:** Vorhandene Module und Schnittstellen weiterverwenden. Die folgenden Typen, Dateinamen und APIs sind konzeptionelle Vorschläge, keine Behauptungen über die aktuelle Codebasis. Änderungen an bestehenden Schnittstellen nur bei Notwendigkeit und möglichst abwärtskompatibel vornehmen.

## 3. Funktionale Anforderungen

### 3.1 Intents und semantisches Zwischenformat

Mindestens die Operationen `set`, `adjust`, `step`, `next`, `previous` und `setColor` unterscheiden. Relative Befehle normalisieren, z. B.:

```ts
interface RelativeCommand {
    intent: 'adjust' | 'step' | 'next' | 'previous';
    targetText: string;
    property?: CapabilityProperty;
    semanticAction: string; // z.B. brighter, warmer, louder, openMore
    intensity: Intensity;
    explicitAmount?: { value: number; unit?: string };
    language: 'de' | 'en';
}

type Intensity = 'tiny' | 'small' | 'normal' | 'large' | 'max';

type CapabilityProperty =
    | 'brightness'
    | 'temperature'
    | 'colorTemperature'
    | 'volume'
    | 'saturation'
    | 'position'
    | 'tilt'
    | 'humidity'
    | 'fanSpeed'
    | 'playbackSpeed';
```

Das Format darf an vorhandene Projektmodelle angepasst werden. Ein Parser soll _semantische_ Aktionen liefern, nicht blind `+1`/`-1`.

### 3.2 Sprachliche Intensität

Standardmäßig fünf Intensitäten:

| Stufe    | Deutsche Beispiele                       | Englische Beispiele        |
| -------- | ---------------------------------------- | -------------------------- |
| `tiny`   | minimal, ganz wenig, ein klein wenig     | barely, a tiny bit         |
| `small`  | etwas, ein wenig, ein bisschen           | a little, slightly         |
| `normal` | heller, wärmer, lauter (ohne Verstärker) | brighter, warmer, louder   |
| `large`  | deutlich, viel, wesentlich, sehr viel    | much, significantly, a lot |
| `max`    | maximal, ganz, so weit wie möglich       | maximum, all the way       |

Synonyme und Varianten zentral und sprachabhängig pflegen. Negation („nicht heller“), widersprüchliche Angaben und Mehrdeutigkeiten erkennen; keine ungewollte Ausführung. „Sehr“ allein muss kontextabhängig behandelt werden und darf nicht grundsätzlich `max` bedeuten.

**Wichtig:** `max` ist zunächst die höchste _Schrittintensität_, nicht automatisch „setze auf den absoluten Maximalwert“. Eindeutige Endpunktbefehle wie „auf maximale Helligkeit“ oder „ganz öffnen“ müssen separat als absolute Zielwertbefehle erkannt werden.

Explizite Werte („um 2 Grad wärmer“, „10 Prozent heller“, „eine Stufe höher“) haben Vorrang vor impliziten Profil-Schritten, sofern Einheit und Capability kompatibel sind.

### 3.3 Semantische Capability-Auflösung

Capability-Erkennung bevorzugt vorhandene Discovery und ioBroker-Objektmetadaten:

- `common.role`, `common.type`, `common.min`, `common.max`, `common.unit`, `common.states`, ggf. `common.step` und vorhandene gerätespezifische Informationen.
- Konfigurierbare Mapping-Regeln und explizite Overrides nur bei Bedarf.
- Die Schreibbarkeit und Benutzerfreigabe müssen durch die bereits existierenden Sicherheitsregeln bestätigt werden.
- Keine Ableitung allein aus dem State-Namen, wenn Metadaten widersprechen; unbekannte oder mehrdeutige States nicht automatisch beschreiben.

Vorgeschlagenes internes Modell:

```ts
interface ResolvedCapability {
    stateId: string;
    property: CapabilityProperty;
    valueType: 'number' | 'enum' | 'color' | 'action';
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    writable: boolean;
    approved: boolean;
    enumValues?: Array<string | number>;
    scale?: 'linear' | 'discrete';
    directionInverted?: boolean;
    colorFormat?: 'hex' | 'rgb' | 'hsv' | 'hsl' | 'xy' | 'kelvin' | 'deviceSpecific';
}
```

Wenn ein Gerät mehrere passende States hat, Ziel-State deterministisch nach vorhandenen Projektregeln auswählen oder bei echter Mehrdeutigkeit nachfragen/abbrechen.

### 3.4 Profile und Default-Schrittweiten

Berechnungsmodi:

- `absolute`: feste Einheit (z. B. °C).
- `percentRange`: Anteil am _gesamten gültigen Wertebereich_ `(max - min)`, nicht Anteil am aktuellen Wert.
- `enumStep`: eine oder mehrere definierte Stufen entlang der zulässigen Enum-Reihenfolge.
- `semantic`: gerätespezifische Operation oder besondere Transformation, z. B. Farbton/-sättigung.

**Startwerte sind Vorschläge, die durch Tests validiert werden müssen:**

| Property         | Modus        |   tiny |  small | normal |  large |    max |
| ---------------- | ------------ | -----: | -----: | -----: | -----: | -----: |
| brightness       | percentRange |    2 % |    5 % |   10 % |   20 % |   35 % |
| temperature °C   | absolute     | 0,5 °C | 1,0 °C | 2,0 °C | 3,0 °C | 4,0 °C |
| temperature °F   | absolute     | 1,0 °F | 2,0 °F | 4,0 °F | 6,0 °F | 8,0 °F |
| colorTemperature | percentRange |    2 % |    5 % |   10 % |   20 % |   35 % |
| volume           | percentRange |    2 % |    5 % |   10 % |   20 % |   30 % |
| saturation       | percentRange |    2 % |    5 % |   10 % |   20 % |   35 % |
| position         | percentRange |    3 % |    5 % |   10 % |   20 % |   30 % |
| tilt             | percentRange |    3 % |    5 % |   10 % |   20 % |   30 % |
| humidity         | absolute     |  1 %RH |  2 %RH |  5 %RH | 10 %RH | 15 %RH |
| fanSpeed         | enumStep     |      1 |      1 |      1 |      2 |      3 |

Für `playbackSpeed` und diskrete, herstellerspezifische Geräte zunächst nur mit nachgewiesener Werte-/Stufenlogik aktivieren. Fehlende Grenzen bei `percentRange` nicht schätzen. Absolute Werte dürfen nur bei eindeutiger Einheit und plausiblen Grenzen verwendet werden.

**Overrides:** `built-in defaults` → `global/property override` → `device/state override`; die spezifischste definierte Einstellung gewinnt. Nicht definierte Einträge erben den Default. Migration und Konfiguration müssen bestehende Installationen unverändert weiter betreiben.

### 3.5 Berechnung, Grenzen und Rundung

1. Aktuellen Wert frisch aus dem State lesen; keine veralteten Discovery-Werte als Istwert verwenden.
2. Richtung semantisch bestimmen und bei Bedarf anhand des Geräte-Mappings invertieren.
3. Delta nach Profil und Intensität bestimmen oder explizite Änderung anwenden.
4. Ergebnis auf gültigen Wertebereich begrenzen (`clamp`).
5. Auf unterstützte Schrittweite runden; dabei `min` als Rasterursprung beachten (`min + n * step`), anschließend erneut Grenzen prüfen.
6. Bei bereits erreichtem Grenzwert nicht sinnlos schreiben; geeignete Rückmeldung erzeugen.
7. Nichtnumerische/ungültige Werte, NaN, fehlende Grenzen, fehlende Schreibberechtigung und nicht unterstützte Formate sicher ablehnen.
8. Mehrere schnell aufeinanderfolgende Befehle pro State serialisieren oder mit einer konsistenten Read-Modify-Write-Strategie ausführen, um verlorene Updates zu vermeiden. Externe Änderungen berücksichtigen.

Pseudocode:

```ts
async function executeRelative(cmd: RelativeCommand, cap: ResolvedCapability) {
    assertApprovedAndWritable(cap);
    const current = await readCurrentState(cap.stateId);
    const delta = resolveDelta(cmd, cap, resolveEffectiveProfile(cap));
    const sign = resolveNumericDirection(cmd.semanticAction, cap);
    const raw = current + sign * delta;
    const target = clampAndQuantize(raw, cap.min, cap.max, cap.step);
    if (target !== current) await executeViaExistingWritePath(cap, target);
    return { current, target, changed: target !== current };
}
```

### 3.6 Kontext und Richtung

Die gleiche Formulierung kann unterschiedliche Properties betreffen:

- „Heizung wärmer“ → Solltemperatur erhöhen.
- „Licht wärmer“ → Farbtemperatur in Kelvin **senken**; bei einem Mired-State ist die numerische Richtung umgekehrt.
- „Rollladen weiter runter“ → physikalische Bewegung nach unten; numerische Richtung hängt von der Geräte-Skala ab.
- „Jalousie steiler“ → Neigungsrichtung hängt vom konkreten Mapping ab.

Daher semantische Richtung getrennt von numerischer Richtung halten. Ohne zuverlässige Richtungsmapping-Information nicht blind schreiben. Wenn die Äußerung keinen eindeutigen Bezug zu einem Ziel hat, bestehende Kontext-/Disambiguierungslogik nutzen oder Rückfrage statt willkürlicher Gerätewahl.

### 3.7 Farbsteuerung

**Direkte Farben:** Farbwort-Lexikon für DE/EN (u. a. rot/red, grün/green, blau/blue, gelb/yellow, orange, violett/purple, lila, pink, türkis/turquoise, cyan, weiß/white, warmweiß/warm white, kaltweiß/cool white). Normalisierte Zielfarbe intern in einem kanonischen Modell (z. B. sRGB und/oder HSV) abbilden. Konvertierung erst am Geräteadapter/Capability-Resolver.

**Relative Farbänderungen:**

- „satter“, „kräftiger“, „intensiver“ → Sättigung erhöhen, sofern eindeutig.
- „blasser“, „pastelliger“, „weniger gesättigt“ → Sättigung verringern.
- „heller/dunkler“ bei RGB → Helligkeit/Value bzw. passende Geräte-Brightness, nicht ungefragt Hue ändern.
- „wärmer/kälter“ bei Weißlicht → Farbtemperatur, sofern unterstützt.
- „etwas mehr Rot“ ist mehrdeutig: erst in einer späteren Phase über eine explizit definierte RGB-Kanal-/Hue-Semantik unterstützen; ansonsten nicht raten.

Konvertierungen zunächst nur für zuverlässig identifizierte Formate anbieten (z. B. HEX-RGB, RGB, HSV, HSL, Kelvin). XY/CIExy, RGBW, CT/Mired und proprietäre Formate nur nach geprüfter Konvertierung und Capability-Information. Gamut-/Wertebereichsbegrenzung beachten. Bei nicht unterstütztem Format verständliche Fehlermeldung statt falscher Farbe.

**Farbbefehle sollen nicht automatisch eine ausgeschaltete Lampe einschalten**, sofern dies nicht bereits ein etabliertes und ausdrücklich vorgesehenes Adapterverhalten ist.

### 3.8 Weitere Gerätetypen

- `volume`: relative Lautstärke; 0–100 oder 0–255 über Range-Skalierung.
- `fanSpeed`: diskrete Stufen, nicht prozentual auf unzuverlässige Enum-Codes rechnen.
- `humidity`: Änderung des Zielwerts, nicht des gemessenen Istwerts.
- `position`/`tilt`: Geräteskalierung und Richtung prüfen.
- `next`/`previous`: Ereignis-/Action-Operationen, keine numerische Read-Modify-Write-Änderung.
- `playbackSpeed`: nur falls Schreibstate und zulässige Stufen explizit bekannt.

## 4. Konfiguration und Admin UI

**Standard:** Bestehende freigegebene Geräte nutzen automatisch erkannte Capabilities und eingebaute Profile; keine verpflichtenden neuen Formulare.

Optionale Konfiguration in zwei Ebenen:

1. **Erweitert → Relative Steuerung:** globale Profile je Property, Aktivierung/Deaktivierung, Intensitätswerte und Wiederherstellung der Defaults.
2. **Gerät/State → Erweiterte Einstellungen:** automatisch erkannte Capability, Grenzen, Einheit, Schrittweite, invertierte Richtung und optionale Profil-Overrides; nur anzeigen, wenn sinnvoll.

Anzeigen, ob ein Wert automatisch erkannt, global geerbt oder lokal überschrieben ist. Warnung bei fehlenden Grenzen/unsicherer Richtung. Eine Vorschau wie „aktueller Wert 50 → bei 'etwas heller' 55“ ist wünschenswert, aber keine Pflicht für die erste Phase.

Neue Konfigurationsfelder mit Defaults und validierter Migration einführen; alte Konfigurationen und Installationen müssen ohne Eingriff weiter funktionieren. Keine versehentliche automatische Freigabe neuer States.

## 5. Schnittstellen und Kompatibilität

- Bestehende Text-Input-, `sendTo`-, State- und VIS-Integrationen erhalten.
- Neue Befehle durch denselben bestehenden Parser-/Executor-Pfad verarbeiten.
- Vorhandene Response-Struktur nur additiv erweitern, z. B. um `property`, `intensity`, `previousValue`, `targetValue`, `appliedDelta` und begründete Fehlercodes.
- Keine Breaking Changes an bestehenden Intents, Gerätefreigaben oder Konfigurationsschlüsseln ohne dokumentierte Migration.
- Fehlercodes möglichst strukturiert: `TARGET_AMBIGUOUS`, `CAPABILITY_UNSUPPORTED`, `MISSING_RANGE`, `DIRECTION_UNKNOWN`, `STATE_NOT_WRITABLE`, `STATE_NOT_APPROVED`, `INVALID_CURRENT_VALUE`, `COLOR_FORMAT_UNSUPPORTED`.
- Log-Ausgaben nachvollziehbar, aber ohne unnötige personenbezogene Inhalte; Debug-Logging optional.

## 6. Sicherheit und Zuverlässigkeit

- Nur bereits freigegebene und tatsächlich schreibbare Zielstates bedienen.
- Keine automatischen Schreibversuche auf Messwerte (`ACTUAL_TEMPERATURE`, Ist-Feuchte etc.).
- Bei Mehrdeutigkeit, unbekannter Einheit oder fehlender Metadatenbasis nicht raten.
- Wertebereich, diskrete Stufen und Gerätelimits stets einhalten.
- Bei relativen Befehlen frischen Zustand lesen; bei fehlender Zustandsqualität/ungültigem Wert nicht schreiben.
- Bestehende Rechte-, Freigabe- und Ausführungsprüfungen wiederverwenden.
- Fehlgeschlagene Writes und Teilfehler korrekt zurückmelden; keine Erfolgsmeldung vor bestätigter Ausführung nach bestehender Adaptersemantik.
- Für sicherheitskritische Aktoren (z. B. Schlösser, Türen, Fenster) keine neuen impliziten Steuerfähigkeiten allein aufgrund ähnlicher Sprachwörter freischalten.

## 7. Tests und Akzeptanzkriterien

Automatisierte Unit- und Integrationstests nach vorhandener Projektkonvention ergänzen.

### Parser-Tests

- „etwas heller“ → brightness/increase/small.
- „deutlich wärmer“ bei Thermostat → temperature/increase/large.
- „Licht wärmer“ → colorTemperature/warmer.
- „nicht heller“ → keine Ausführung.
- DE/EN-Synonyme und alternative Wortstellungen.
- „um 2 Grad wärmer“ → explizite Änderung mit Vorrang.
- „auf maximale Helligkeit“ → absoluter Endpunkt statt `max`-Delta.

### Rechen-Tests

- Brightness 0–100, Ist 50, normal 10 % → 60.
- Brightness 0–254, Ist 127, small 5 % → 140 bei Schrittweite 1 (definierte Rundungsregel).
- Temperatur Ist 20,5 °C, normal → 21,5 °C.
- Temperatur mit 0,5-°C-Raster → gültiges Rasterergebnis.
- Werte nahe `min`/`max` → korrekt geklemmt.
- Nichtnull-Minimum und Schrittweitenraster → korrekt gerundet.
- Enum mit nichtkontinuierlichen Codes → nächster erlaubter Eintrag, nicht `+1` auf Code.
- Farbtemperatur Kelvin: wärmer → numerisch kleiner; Mired: wärmer → numerisch größer.
- Invertierte Rollladen-Skala → physikalisch korrekte Richtung.
- Fehlende Grenzen bei percentRange → sicherer Abbruch.

### Integration/Regression

- Nur freigegebene States beschreibbar.
- Alte absolute Schaltbefehle funktionieren unverändert.
- `sendTo` und VIS bleiben kompatibel.
- Persistenz/Migration bestehender Admin-Konfiguration.
- Wiederholte relative Befehle auf denselben State ohne verlorene Updates.
- Farbeingaben in allen tatsächlich unterstützten Formaten; nicht unterstützte Formate werden abgelehnt.
- Fehler und Grenzwertfälle liefern strukturierte, verständliche Rückmeldungen.

## 8. Phasenplan für Codex

### Phase 0 – Bestandsaufnahme und Design-Abgleich

- Repository analysieren und konkrete Integrationspunkte festhalten.
- Abweichungen zwischen dieser Spezifikation und realer Architektur dokumentieren.
- Minimalen Implementierungsplan mit betroffenen Dateien und vorhandenen Tests erstellen.
- Keine großflächigen Refactorings.

**Abnahme:** nachvollziehbare Zuordnung von Parser, Discovery, Freigabe, Executor, Admin UI und Tests.

### Phase 1 – Kern für relative Zahlenwerte (MVP)

- Semantisches Kommandomodell und Intensitätslexikon DE/EN.
- Capability-Erkennung für brightness, temperature, volume.
- Default-Profile und Rechenmodi `absolute`/`percentRange`.
- Grenzen, Raster, sichere Schreibausführung und Fehlerbehandlung.
- Unit-/Integrationstests und Regressionstests.

**Abnahme:** „etwas heller“, „wärmer“, „leiser“ funktionieren mit automatisch erkannten, freigegebenen Geräten ohne neue Pflichtkonfiguration.

### Phase 2 – Weitere Capabilities und Richtung

- `colorTemperature`, `humidity`, `position`, `tilt`, `fanSpeed`.
- `enumStep`, Richtungsinversion, semantische Mappings.
- `next`/`previous` über vorhandene Action-/Event-Mechanismen, falls verfügbar.
- Tests für Kelvin/Mired, Rollladen, diskrete Stufen.

**Abnahme:** sprachliche Richtungen werden gerätespezifisch korrekt umgesetzt; unbekannte Mappings werden nicht erraten.

### Phase 3 – Farbsteuerung

- Farbwort-Lexikon DE/EN und direkte Farbsetzung.
- Normalisierte Farbrepräsentation und nachgewiesene Formatkonverter.
- Relative Sättigungs-/Helligkeitsänderungen.
- Tests für Formatgrenzen, Farbkonvertierung und Fehlermeldungen.

**Abnahme:** benannte Farben sowie „satter/blasser“ funktionieren bei unterstützten, freigegebenen RGB-Geräten.

### Phase 4 – Optionale Konfiguration und UI

- Globale Property-Overrides und State-Overrides mit Vererbung.
- UI für erweiterte Konfiguration und erkannte Capabilities.
- Konfigurationsmigration, Validierung, Dokumentation.

**Abnahme:** Standardbenutzer benötigen keine Konfiguration; Experten können Schrittweiten und Richtungen gezielt überschreiben.

### Phase 5 – Stabilisierung und Dokumentation

- Vollständige Regression, Testabdeckung und manuelle Tests mit repräsentativen Geräten.
- README/Anwenderdokumentation mit Beispielen DE/EN, Grenzen und Troubleshooting.
- Changelog und ggf. Migrationshinweise.
- Performance und Race-Condition-Verhalten prüfen.

**Abnahme:** Tests/Build/Lint nach Projektstandard erfolgreich; bestehende Funktionen bleiben intakt.

## 9. Implementierungsvorgaben

1. Vorhandene Architektur und Namenskonventionen respektieren; keine pauschalen neuen Ordner-/Modulstrukturen erzwingen.
2. Neue Logik möglichst in testbare Parser-, Profil-, Capability- und Value-Resolver-Komponenten kapseln.
3. Parser und Geräteschreibpfad strikt trennen; keine Gerätezugriffe in Sprachregeln.
4. Profile zentral und deklarativ definieren, keine verstreuten Wort→Zahl-Zuordnungen.
5. Keine neue Runtime-Abhängigkeit ohne klare Notwendigkeit und Begründung.
6. DE/EN von Beginn an unterstützen, falls der Adapter dies bereits anbietet.
7. Jede Phase mit Tests und kurzem Änderungsbericht abschließen; keine ungetesteten Breaking Changes.
8. Bei Widersprüchen zwischen Beispielen und realen Geräte-Metadaten hat die sichere, dokumentierte Geräte-Semantik Vorrang.

## 10. Arbeitsauftrag an Codex

> Erweitere das bestehende Repository `ioBroker.smart-text2command` gemäß dieser Spezifikation. Beginne mit Phase 0: Untersuche die tatsächliche Codebasis und identifiziere die bestehenden Parser-, Discovery-, Freigabe-, Executor-, Konfigurations- und Test-Schnittstellen. Erstelle einen knappen Umsetzungsplan auf Basis der realen Architektur. Implementiere anschließend die Phasen schrittweise und abwärtskompatibel. Verwende die hier genannten Typen und Dateistrukturen nur als konzeptionelle Vorschläge. Achte besonders auf semantische Richtung, sichere Capability-Auflösung, gerätespezifische Wertebereiche, optionale Overrides, DE/EN-Unterstützung und automatisierte Regressionstests. Führe vorhandene Prüfungen aus und dokumentiere Ergebnisse sowie noch nicht unterstützte Geräteformate.
