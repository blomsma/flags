# Flags — lokaal op een evenement-NUC

3D-vlaggenceremonie met een aparte bediening, live synchronisatie via WebSocket en een REST-API voor show control. De app draait volledig lokaal. Landenvlaggen, achtergrondmedia, de huidige serverinstellingen en alle broncode zijn inbegrepen.

## Landen en vlaggen voor het evenement

De selectie volgt de aangeleverde lijst: 82 landen plus World Gymnastics 1 en 2. Namen zoals Chinese Taipei, Hong Kong, China, Great Britain en Türkiye staan zoals opgegeven in de bediening.

39 vlaggen komen uit het aangeleverde archief. Chinese Taipei gebruikt de aangeleverde comitévlag. Voor Frankrijk is alleen de horizontale vlag uit de PDF overgenomen, met dezelfde kleuren; tekst en kleurreferenties zijn weggelaten. Bij Denemarken zijn de witte marges van het referentieblad verwijderd. Grote bronafbeeldingen zijn verkleind tot maximaal 1920×1280 om het geheugengebruik te beperken; het bronbestand en de omzetting staan in het bronoverzicht. De andere 43 landen gebruiken de meegeleverde SVG-vlaggen van `flag-icons`. Alle afbeeldingen werken zonder Dropbox of internet.

**World Gymnastics 1 en 2 ontbreken in het archief.** Deze staan zichtbaar maar uitgeschakeld in de selectie totdat hun afbeeldingen zijn aangeleverd. Je kunt ze ondertussen als eigen vlag uploaden. Eigen uploads en bestaande presets blijven werken, ook voor landen buiten de evenementlijst.

De lijst staat in `src/shared/event-flags.json`, aangeleverde afbeeldingen in `public/event-flags/` en bronbestanden met SHA-256-controlesommen in `docs/event-flags-sources.json`. Nieuwe installaties en Docker-builds nemen deze afbeeldingen automatisch mee. Bestaande Docker-installaties krijgen de update met `git pull` en het startscript; instellingen en uploads blijven in het volume.

## Installeren

Installeer **Docker met Compose v2.24 of nieuwer** en Git op de NUC. Linux: [Docker Engine voor Ubuntu](https://docs.docker.com/engine/install/ubuntu/) met de [Compose-plugin](https://docs.docker.com/compose/install/linux/). Windows: [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), met Linux-containers. Je hebt geen losse Node-installatie nodig. Houd minimaal 3 GB vrije ruimte beschikbaar, plus ruimte voor eigen uploads en back-ups.

Linux, vanuit een terminal:

```sh
git clone https://github.com/blomsma/flags.git
cd flags
bash scripts/start.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/blomsma/flags.git
cd flags
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

Dit is een privérepo; gebruik je eigen GitHub-aanmelding of download de ZIP via GitHub en pak deze uit. De eerste build heeft internet nodig. Dependencies en de productiefrontend worden automatisch in Docker gebouwd. Daarna start de app zonder downloads.

- Bediening: **http://localhost:4174/control.html**
- Uitvoer: **http://localhost:4174/**
- Status: http://localhost:4174/api/v1/health

Op een andere computer gebruik je het IP-adres van de NUC, bijvoorbeeld `http://192.168.1.50:4174/control.html`. Beide apps kunnen tegelijkertijd draaien: Streamcards gebruikt poort 8787.

## Gebruik tijdens het evenement

Open de bediening in één browser en de uitvoer op het scherm of als OBS-browserbron. Gebruik in OBS de HTTP-URL en bijvoorbeeld 1920×1080. Voor bediening vanaf een laptop moeten laptop en NUC op hetzelfde LAN zitten. Geef de NUC een vast IP-adres of DHCP-reservering en laat poort 4174 door de firewall toe op het evenementnetwerk.

De browser die de uitvoer tekent heeft WebGL en hardwareversnelling nodig. Test de daadwerkelijke NUC, resolutie en hoeveelheid vlaggen vóór het evenement. Bij lage FPS: verlaag de meshkwaliteit of schakel self-collision uit. Docker doet de synchronisatie; de GPU-rendering gebeurt in de browser op het apparaat waarop je de uitvoer opent.

De app is bedoeld voor een vertrouwd lokaal evenementnetwerk. Iedereen die de poort kan bereiken kan de bediening gebruiken. Publiceer deze poort niet op internet. `API_TOKEN` beschermt alleen REST-mutaties en is geen beveiliging voor de browser/WebSocket-bediening.

## Configuratie en herstarten

Het startscript maakt `.env` uit `.env.example`. Daar kun je de poort wijzigen:

```dotenv
BIND_ADDRESS=0.0.0.0
APP_PORT=4174
TZ=Europe/Amsterdam
```

Gebruik `BIND_ADDRESS=127.0.0.1` als alleen de NUC zelf toegang nodig heeft. Na wijzigen: voer het startscript opnieuw uit.

Instellingen en uploads staan in een Docker-volume. Herstarten en opnieuw bouwen bewaren deze gegevens. Startinstellingen en originele media uit `seed/` worden gekopieerd als ze nog ontbreken. De server herstelt de laatste instellingen na een herstart; er wordt geen nieuwe hijsbeweging gestart. Browserpresets blijven in de browseropslag; exporteer belangrijke presets via de bediening.

```sh
docker compose ps
docker compose logs --tail=100
docker compose restart
docker compose stop
```

De container start automatisch mee wanneer Docker na een reboot start, zolang je hem niet handmatig hebt gestopt. Zorg onder Linux dat Docker bij boot start. Onder Windows moeten Docker Desktop en de gebruikerssessie starten; controleer dit vóór het evenement. Zet slaapstand en automatische herstarts tijdens de show uit.

## Back-up en herstel

De back-up bevat instellingen en uploads. Het script stopt de app kort voor een consistente kopie en start hem daarna weer.

```sh
bash scripts/backup.sh
bash scripts/restore.sh backups/flags-YYYYMMDD-HHMMSS.tar.gz
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
powershell -ExecutionPolicy Bypass -File scripts/restore.ps1 -Archive backups/flags-YYYYMMDD-HHMMSS.tar.gz
```

Herstellen maakt eerst een extra back-up van de aanwezige data. Het overschrijft gegevens uit het gekozen archief; overige mediabestanden blijven staan. Gebruik alleen eigen vertrouwde archieven. Kopieer belangrijke back-ups naar een USB-stick. `docker compose down` bewaart het volume; **`docker compose down -v` verwijdert de opgeslagen gegevens**.

## Installatie op een NUC zonder internet

Docker moet vooraf geïnstalleerd zijn. Bouw op een computer met internet een Intel-image:

```sh
bash scripts/export-offline.sh
```

Windows: `powershell -ExecutionPolicy Bypass -File scripts/export-offline.ps1`. De export bouwt expliciet voor `linux/amd64`. Een ARM-computer heeft hiervoor Docker-emulatie nodig. Je kunt ook op GitHub bij **Actions → Verify install → Run workflow** een gecontroleerd Intel-image laten bouwen en het artifact `flags-nuc-amd64` downloaden.

Kopieer de repository en `transfer/images.tar` via USB naar de NUC. Uit een Actions-artifact zet je `images.tar` in `transfer/`. Daar:

```sh
docker image load -i transfer/images.tar
bash scripts/start.sh --offline
```

Windows: `docker image load -i transfer/images.tar`, daarna `powershell -ExecutionPolicy Bypass -File scripts/start.ps1 -Offline`. Voor bestaande evenementdata neem je ook een back-up mee en herstel je die. Alleen een Docker-image bevat geen later geüploade bestanden.

## Ontwikkeling en controles

Node 22.12 of nieuwer:

```sh
npm ci
npm test
npm run build
npm start
```

Browsertest tegen een draaiende app: `npx playwright install --with-deps chromium`, daarna `npm run test:browser`. Met `TEST_BASE_URL` kun je een andere URL gebruiken. GitHub Actions controleert een schone installatie, de server, de Docker-build en de browseruitvoer. De [API-documentatie](docs/API.md) bevat de show-control-endpoints.
