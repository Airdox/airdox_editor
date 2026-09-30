"""
Automatisch generierter Rekordbox-Parser für taktgenaues Schneiden und Cues.
"""
import xml.etree.ElementTree as ET

def load_rekordbox_xml(xml_path):
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception as e:
        print(f"Fehler beim Laden der XML: {e}")
        return []

    tracks = []
    for track in root.findall(".//TRACK"):
        track_info = {
            "id": track.get("TrackID"),
            "name": track.get("Name"),
            "artist": track.get("Artist"),
            "bpm": float(track.get("AverageBPM", 120.0)),
            "path": track.get("Location", "").replace("file://localhost", "").replace("%20", " "),
            "cue_points": [],
            "beatgrid": []
        }
        for pos in track.findall("POSITION_MARK"):
            track_info["cue_points"].append({
                "name": pos.get("Name"),
                "start": float(pos.get("Start", 0.0)),
                "type": pos.get("Type")
            })
        for tempo in track.findall("TEMPO"):
            track_info["beatgrid"].append({
                "bpm": float(tempo.get("BPM", 120.0)),
                "time": float(tempo.get("Inizio", 0.0))
            })
        tracks.append(track_info)
    return tracks
