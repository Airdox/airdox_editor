import { env } from '@xenova/transformers';

// Configure transformers.js to load models correctly in the browser
env.allowLocalModels = false; // Wir holen die Modelle direkt aus dem Hugging Face Hub (Web)
env.useBrowserCache = true; // Zwischenspeichern, damit es beim 2. Mal schneller geht
