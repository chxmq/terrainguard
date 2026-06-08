# Terrain Guard — Audio Files

Place the following audio files in this directory (frontend/public/):

## Required
- `terrain-pullup.aac`   — Your "Terrain, pull up!" voice callout (AAC format).
                           Plays when clearance_ft drops below 1500 ft during Fly Route simulation.
                           Also triggers the full-screen red WARNING overlay.

## Optional
- `obstacle-caution.aac` — A secondary caution tone/voice for OBSTACLE AHEAD alerts.
                           Plays when clearance_ft is between 1500–3000 ft (CAUTION band).
                           If this file is missing, a synthesised 880 Hz beep plays instead.

## How audio is triggered

| Clearance     | Visual                  | Audio                       |
|---------------|-------------------------|-----------------------------|
| < 1500 ft     | Red pulse + PULL UP     | terrain-pullup.aac          |
| 1500–3000 ft  | Amber flash + CAUTION   | obstacle-caution.aac / beep |
| > 3000 ft     | None                    | None                        |

Audio fires ONCE per state transition (CLEAR → CAUTION, or any → WARNING).
It does NOT repeat on every tick — only when the alert level changes.

## Browser autoplay policy
Browsers block autoplay until the user has interacted with the page (clicked anything).
Once the user clicks "Fly Route" to start the simulation, audio will work normally.
