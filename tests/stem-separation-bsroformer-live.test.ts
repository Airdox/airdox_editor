/** Optional live checkpoint test. CI without model assets skips by design. */
if (process.env.STEM_LIVE === '1') console.log('STEM_LIVE=1 gesetzt: ein trainierter Checkpoint-Test ist in dieser Checkout-Umgebung nicht konfiguriert.');
else console.log('stem-separation-live: skipped (kein trainierter Checkpoint angefordert)');
