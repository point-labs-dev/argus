# Scenario: First Camera Setup

## User Story
Peter has a Reolink RLC-810A camera on his network at 192.168.1.100. He installs Argus, creates a config file with the camera's IP and credentials, and starts Argus. He expects the camera to appear in Apple Home within a few minutes.

## Steps
1. Create `argus.yaml` with one camera configured
2. Run `argus start`
3. Observe console output for successful startup
4. Open Apple Home app on iPhone
5. Add Accessory → scan/enter pairing code
6. Camera appears in Home app
7. Tap camera → live stream loads
8. Walk in front of camera → motion notification appears

## Satisfaction Criteria
- Startup completes without errors
- go2rtc launches and camera stream is accessible
- HAP accessory is discoverable via mDNS
- Pairing succeeds on first attempt
- Live stream loads in < 5 seconds
- Stream is stable (no freezing/artifacts for 60 seconds)
- Motion event triggers within 5 seconds of movement
