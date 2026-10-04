def fix_track_import_path(t):
    if not t.get('path') and t.get('title'):
        t['path'] = f"C:/PIONEER/MUSIC/{t.get('artist', 'Unknown')} - {t.get('title', 'Unknown')}.mp3"
    return t

print('Patch geladen.')