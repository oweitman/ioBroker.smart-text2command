# Testanleitung ohne echte Geräte

Diese Anleitung erstellt virtuelle Datenpunkte unter `0_userdata.0`. Die Werte werden nur in ioBroker gespeichert; es wird keine Hardware geschaltet. Für den Test werden die Geräte und **jede Aktion** anschließend im Admin von `smart-text2command.0` freigegeben.

## 1. Räume und Funktionen anlegen

In ioBroker Admin unter **Aufzählungen** (Enums) die Räume **Wohnzimmer** und **Schlafzimmer** sowie die Funktionen **Licht** und **Heizung** anlegen. Die automatisch erzeugten IDs sollten `enum.rooms.wohnzimmer`, `enum.rooms.schlafzimmer`, `enum.functions.licht` und `enum.functions.heizung` sein. Wenn Admin andere IDs vergibt, diese für die Raumabfrage merken: Der Adapter wertet den letzten Teil der Raum-ID aus.

## 2. Testobjekte anlegen

Unter **Objekte → 0_userdata.0** vier Kanäle erstellen. Die Kanalnamen sind die späteren Gerätenamen im Adapter. Darunter die folgenden States anlegen. `read` und `write` sind Metadaten des States; sie müssen nach dem Setzen des Anfangswerts wie in der Tabelle stehen bleiben.

Im ioBroker-Objekteditor kann das Feld **Gerät** bei diesen States leer bleiben: Es wurden Kanäle, aber keine übergeordneten Objekte vom Typ `device` angelegt. `smart-text2command` verwendet den nächstgelegenen Kanal als Gerät und übernimmt dessen Name und Raumzuordnung.

| Kanal-ID unter `0_userdata.0` | Kanalname        | State-ID     | Rolle               | Typ     | read | write | Min | Max | Einheit | Anfangswert |
| ----------------------------- | ---------------- | ------------ | ------------------- | ------- | ---- | ----- | --: | --: | ------- | ----------- |
| `test_lampe_wohnzimmer`       | Lampe            | `POWER`      | `switch`            | boolean | ja   | ja    |   – |   – | –       | `false`     |
| `test_lampe_wohnzimmer`       | Lampe            | `HELLIGKEIT` | `level.brightness`  | number  | ja   | ja    |   0 | 100 | `%`     | `50`        |
| `test_lampe_schlafzimmer`     | Lampe            | `POWER`      | `switch`            | boolean | ja   | ja    |   – |   – | –       | `false`     |
| `test_heizung_wohnzimmer`     | Heizung          | `SOLL`       | `level.temperature` | number  | ja   | ja    |   5 |  30 | `°C`    | `21`        |
| `test_heizung_wohnzimmer`     | Heizung          | `IST`        | `value.temperature` | number  | ja   | nein  |   – |   – | `°C`    | `20`        |
| `test_sensor_schlafzimmer`    | Temperatursensor | `IST`        | `value.temperature` | number  | ja   | nein  |   – |   – | `°C`    | `19`        |

Beispiel einer vollständigen State-ID: `0_userdata.0.test_lampe_wohnzimmer.POWER`. Die Rollen `level.dimmer` und `level.temperature.setpoint` müssen für diese Anleitung nicht im Admin-Auswahlfeld vorhanden sein. `level.brightness` ist eine unterstützte Alternative für den Dimmer; `level.temperature` bezeichnet den schreibbaren Sollwert und `value.temperature` den Messwert.

Für die beiden **IST**-States kann es nötig sein, `write` vorübergehend zu aktivieren, um im Admin einen Anfangswert einzutragen. Danach `write` wieder auf **nein** setzen. Bei **POWER**, **HELLIGKEIT** und **SOLL** muss `write` dauerhaft **ja** bleiben, sonst erkennt der Adapter keine schreibbare Aktion. Eine Änderung von `write` nach der Freigabe ändert den Capability-Fingerprint und erfordert eine erneute Freigabe.

## 3. Kanäle zuordnen

Die Kanäle (nicht nur einzelne States) in Admin den Aufzählungen zuordnen:

| Kanal                      | Raum         | Funktion |
| -------------------------- | ------------ | -------- |
| `test_lampe_wohnzimmer`    | Wohnzimmer   | Licht    |
| `test_lampe_schlafzimmer`  | Schlafzimmer | Licht    |
| `test_heizung_wohnzimmer`  | Wohnzimmer   | Heizung  |
| `test_sensor_schlafzimmer` | Schlafzimmer | Heizung  |

Die zwei Kanäle mit dem Namen **Lampe** sind absichtlich gleich benannt. Damit lassen sich Rückfragen und die Raumzuordnung testen.

## 4. Adapter starten und Freigaben setzen

`smart-text2command.0` starten. Im Adapter-Admin unter **Geräte** prüfen, ob die vier Kanäle mit ihren States erscheinen. Bei **jedem** gewünschten Gerät den Schalter **Aktiv** einschalten und die konkreten Aktionen einzeln freigeben. Eine Aktionsfreigabe allein aktiviert das Gerät nicht:

| Gerät                         | Freigaben                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Lampe Wohnzimmer              | `turnOn`, `turnOff`, `getState` für `POWER`; `setLevel`, `getValue` für `HELLIGKEIT` |
| Lampe Schlafzimmer            | `turnOn`, `turnOff`, `getState` für `POWER`                                          |
| Heizung Wohnzimmer            | `setTemperature` für `SOLL`; `getValue` für `IST`                                     |
| Temperatursensor Schlafzimmer | `getValue` für `IST`                                                                 |

Vor der Freigabe im Dialog Ziel-State, Rolle, Datentyp, Wertebereich und Lese-/Schreibbarkeit prüfen. Falls ein State nach einer Metadatenänderung `needsReview` zeigt, die betroffene Aktion erneut prüfen und freigeben.

Im Geräte-Tab zeigen die Raum- und Funktionsfilter die Namen der ioBroker-Aufzählungen an. Hinter dem Gerätenamen steht die technische Geräte-ID in Klammern. Jede Gerätekarte trennt Aliase von Aktionsfreigaben. Aliase stehen in einer zweispaltigen Tabelle mit Sprachwahl und Eingabefeld; mit dem Plus kann eine weitere unterstützte Sprache ergänzt werden.

Für die Formulierung **„könntest du freundlicherweise die Leuchte im Wohnzimmer deaktivieren“** bei beiden Lampen den deutschen Alias `Leuchte` eintragen und speichern. Der Raum unterscheidet die Geräte. Ohne Raum fragt der Adapter bei mehreren passenden Räumen zuerst nach dem Raum. Die Aktion `turnOff` muss für die jeweilige Lampe freigegeben und das Gerät aktiv sein.

Die Sammelaktionen verwenden ein Auge für Lesen, einen Stift für Schreiben und beide Symbole für die Kombination. Grün öffnet die Freigabe, grau mit rotem Verbotssymbol die Rücknahme. Beide Wege zeigen eine Prüfliste der betroffenen Aktionen und Ziel-States; einzelne Einträge können abgewählt werden. Der Schalter **Aktiv** bleibt eine eigene Entscheidung.

Die Filter für Raum und ioBroker-Funktion enthalten **Ohne** für Geräte ohne entsprechende Zuordnung. Geräte ohne unterstützte Capability werden im Tab **Geräte** ausgeblendet und nicht mitgezählt. **Geräte neu einlesen** fragt die aktuellen ioBroker-Objekte erneut ab. Fehlende Objekte verschwinden danach aus der Ansicht. Alte Freigaben bleiben gespeichert, können ohne den zugehörigen State aber nicht ausgeführt werden und lösen allein keine Änderungswarnung aus. Die kompakten Aktionschips zeigen mit einem Plus eine offene Freigabe und mit einem Haken eine freigegebene Aktion; Anklicken öffnet die Prüfung beziehungsweise widerruft die Freigabe. Für diesen Test müssen keine Datenpunkte gelöscht werden.

## 5. Im Testlabor prüfen

Warten, bis `smart-text2command.0.info.modelStatus` **ready** meldet. Im **Testlabor** zuerst **Analysieren** verwenden; **Ausführen** schreibt bei freigegebener Aktion tatsächlich in den virtuellen State.

| Eingabe                                        | Erwartung                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `Schalte die Lampe im Wohnzimmer ein`          | `POWER` der Wohnzimmerlampe wird `true`                                         |
| `Schalte die Lampe aus`                        | Rückfrage nach dem Raum, weil zwei freigegebene Lampen in verschiedenen Räumen passen. |
| `Dimme die Lampe im Wohnzimmer auf 40 Prozent` | `HELLIGKEIT` wird `40`                                                          |
| `Stelle die Heizung im Wohnzimmer auf 22 Grad` | `SOLL` wird `22`                                                                |
| `Stelle im Wohnzimmer die Temperatur auf 25 Grad` | Bei genau einem freigegebenen Temperaturziel wird `SOLL` auf `25` gesetzt; bei mehreren folgt eine Geräterückfrage. |
| `Schreibe im Wohnzimmer die Solltemperatur`    | Rückfrage nach dem fehlenden Wert; nach `21 Grad` wird nur `SOLL` geschrieben.  |
| `Wie warm ist es im Wohnzimmer`                | Analyse plant das Lesen von `IST` der Heizung; die Helligkeit der Lampe zählt nicht als Temperaturwert. |
| `Welche Temperatur hat die Heizung im Wohnzimmer` | Analyse erkennt `device.getValue` und plant das Lesen von `IST` der Heizung. |
| `Wie warm ist es im Schlafzimmer`              | Analyse plant das Lesen von `IST`; Ausführen liefert den Messwert. Bei mehreren passenden Lesegeräten folgt eine Rückfrage. |
| `Wie hell ist die Lampe im Schlafzimmer`        | `device.getValue`; mit den obigen Testdaten: „Ich kenne das Gerät in diesem Raum nicht.“, weil die Schlafzimmerlampe nur `POWER` besitzt. Es wird kein Wert aus dem Wohnzimmer gelesen. |
| `Schalte die Lampe im Kinderzimmer ein`         | „Ich kenne den Raum nicht.“, solange kein Raum `Kinderzimmer` angelegt ist. |

Die NLP-Erkennung und die Geräteauflösung können bei einzelnen Formulierungen Rückfragen auslösen. Im Testlabor die erkannten Intents, Gerätekandidaten und den geplanten State-Zugriff prüfen. Für einen eindeutigen Lesetest kann auch `Welchen Wert hat der Temperatursensor` verwendet werden.

Für einen erfolgreichen Helligkeitslesetest `Wie hell ist die Lampe im Wohnzimmer` verwenden. Soll die Schlafzimmerlampe ebenfalls einen Helligkeitswert liefern, dort einen lesbaren State mit Rolle `level.brightness` ergänzen, **Geräte neu einlesen** und `getValue` für diesen State freigeben.

Die mitgelieferten Trainingssätze enthalten Schreibbefehle für Solltemperaturen auf Deutsch und Englisch, auch ohne Zahlenwert. Nach einem Adapter-Neustart wird ein vorhandenes Modell neu trainiert, wenn sich die Trainingssätze geändert haben. Erst bei `info.modelStatus = ready` erneut testen.

Ein `0_userdata.0`-State simuliert nur den ioBroker-Datenpunkt. Dieser Test bestätigt Erkennung, Freigabe und State-Zugriff; ein echter Geräteadapter muss später separat getestet werden.
