// Generates public/js/lib/logos.js from the simple-icons package (CC0-1.0), keeping only the slugs
// below so the browser never loads the full ~3500-icon set. The frontend has no build step, so the
// output is committed; simple-icons is a devDependency and never reaches the Docker image.
//
//   npm run build:logos
//
// Add a slug here, re-run, then point a SERVICE_BADGES entry in public/js/format.js at it.
// test/format.test.js fails if the two lists drift apart in either direction.
const fs = require('fs');
const path = require('path');
const prettier = require('prettier');

const SLUGS = [
  'adguard',
  'adminer',
  'alpinelinux',
  'apache',
  'apachecassandra',
  'apachecouchdb',
  'apachekafka',
  'apachesolr',
  'apachetomcat',
  'authelia',
  'authentik',
  'bitwarden',
  'caddy',
  'clickhouse',
  'cloudflare',
  'cockroachlabs',
  'consul',
  'debian',
  'docker',
  'dotnet',
  'elasticsearch',
  'envoyproxy',
  'etcd',
  'forgejo',
  'ghost',
  'gitea',
  'gitlab',
  'grafana',
  'homeassistant',
  'homepage',
  'immich',
  'influxdb',
  'jaeger',
  'jellyfin',
  'jenkins',
  'keycloak',
  'kibana',
  'kong',
  'letsencrypt',
  'logstash',
  'mariadb',
  'mattermost',
  'meilisearch',
  'metabase',
  'minio',
  'mongodb',
  'mysql',
  'n8n',
  'neo4j',
  'nextcloud',
  'nginx',
  'nginxproxymanager',
  'nodedotjs',
  'nodered',
  'openjdk',
  'opensearch',
  'opentelemetry',
  'php',
  'phpmyadmin',
  'pihole',
  'plex',
  'portainer',
  'postgresql',
  'prometheus',
  'python',
  'qbittorrent',
  'rabbitmq',
  'radarr',
  'redis',
  'rocketdotchat',
  'rust',
  'sonarr',
  'sonatype',
  'springboot',
  'syncthing',
  'tailscale',
  'temporal',
  'timescale',
  'traefikproxy',
  'ubuntu',
  'umami',
  'uptimekuma',
  'vault',
  'vaultwarden',
  'watchtower',
  'wireguard',
  'wordpress',
];

// Marks that aren't in Simple Icons but are ours to ship. OpenDockWatch's is public/logo.svg redrawn
// in one colour as one filled path, since the original is stroked and two-colour: frame (cut where
// the status dot sits), eye, pupil, dot. `tile` draws it as its own rounded square, not in a circle.
const LOCAL_LOGOS = {
  opendockwatch: {
    title: 'OpenDockWatch',
    bg: '#1d2027',
    fg: '#4f8cff',
    tile: true,
    path:
      // Frame: logo.svg's rect at 0.75 scale, a C-shape broken by a circle around the dot.
      'M19.596 22.498A6.75 6.75 0 0 1 16.5 23.25H7.5A6.75 6.75 0 0 1 0.75 16.5V7.5A6.75 6.75 0 0 1 7.5 0.75H16.5' +
      'A6.75 6.75 0 0 1 23.25 7.5V16.5A6.75 6.75 0 0 1 22.498 19.596A4.3 4.3 0 0 0 21.75 15.711V7.5A5.25 5.25 0 0 0 16.5 2.25' +
      'H7.5A5.25 5.25 0 0 0 2.25 7.5V16.5A5.25 5.25 0 0 0 7.5 21.75H15.711A4.3 4.3 0 0 0 19.596 22.498Z' +
      // Eye: outer lid, then the inner lid wound the other way so it punches the hole.
      'M4.875 12c2.375-3.467 4.75-5.2 7.125-5.2s4.75 1.733 7.125 5.2c-2.375 3.467-4.75 5.2-7.125 5.2s-4.75-1.733-7.125-5.2z' +
      'M17.415 12c-1.805-2.517-3.61-3.776-5.415-3.776s-3.61 1.259-5.415 3.776c1.805 2.517 3.61 3.776 5.415 3.776s3.61-1.259 5.415-3.776z' +
      'M12 9.85a2.15 2.15 0 1 0 0 4.3a2.15 2.15 0 1 0 0-4.3z' +
      // Status dot: ring (outer circle, reverse-wound inner) and centre.
      'M18.375 15.075a3.3 3.3 0 1 1 0 6.6a3.3 3.3 0 1 1 0-6.6z' +
      'M18.375 16.175a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z' +
      'M18.375 17.075a1.3 1.3 0 1 1 0 2.6a1.3 1.3 0 1 1 0-2.6z',
  },
};

// Brand colours are used as the badge background, so each needs a glyph colour that reads on it:
// several brands are yellow (Vault, ClickHouse) where white vanishes. Near-black brands (Rust,
// OpenJDK, Kafka) swap their background for a neutral grey instead, since a black circle
// disappears on the dark flow-view node and the dark-theme list alike.
const DARK_FG = '#1d2027';
const LIGHT_FG = '#ffffff';
const NEAR_BLACK_BG = '#4a4f5c';

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function badgeColours(hex) {
  const l = luminance(hex);
  if (l < 0.03) return { bg: NEAR_BLACK_BG, fg: LIGHT_FG };
  const fg = contrast(l, luminance(DARK_FG.slice(1))) > contrast(l, 1) ? DARK_FG : LIGHT_FG;
  return { bg: `#${hex}`, fg };
}

async function main() {
  const icons = await import('simple-icons');
  const bySlug = new Map(
    Object.values(icons)
      .filter((v) => v && v.slug)
      .map((v) => [v.slug, v])
  );
  // Read off disk: the package's "exports" map doesn't expose ./package.json to require().
  const pkgPath = path.join(__dirname, '..', 'node_modules', 'simple-icons', 'package.json');
  const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const missing = SLUGS.filter((s) => !bySlug.has(s));
  if (missing.length) {
    console.error(`Not in simple-icons@${version}: ${missing.join(', ')}`);
    process.exit(1);
  }

  const entries = SLUGS.map((slug) => {
    const icon = bySlug.get(slug);
    const { bg, fg } = badgeColours(icon.hex);
    return `  ${JSON.stringify(slug)}: { title: ${JSON.stringify(icon.title)}, bg: '${bg}', fg: '${fg}', path: ${JSON.stringify(icon.path)} },`;
  });
  for (const [slug, { title, bg, fg, tile, path: d }] of Object.entries(LOCAL_LOGOS)) {
    const tileField = tile ? ' tile: true,' : '';
    entries.push(
      `  ${JSON.stringify(slug)}: { title: ${JSON.stringify(title)}, bg: '${bg}', fg: '${fg}',${tileField} path: ${JSON.stringify(d)} },`
    );
  }

  const src = `// GENERATED by scripts/build-logos.js from simple-icons@${version} (CC0-1.0), plus this project's own
// mark (LOCAL_LOGOS there) - do not edit by hand.
// Each path is a single-colour glyph on a 24x24 viewBox; bg/fg are the badge colours derived from
// the brand hex. Logos remain their owners' trademarks and are shown only to identify the software.
export const LOGOS = {
${entries.join('\n')}
};
`;

  const out = path.join(__dirname, '..', 'public', 'js', 'lib', 'logos.js');
  const options = (await prettier.resolveConfig(out)) || {};
  fs.writeFileSync(out, await prettier.format(src, { ...options, filepath: out }));
  console.log(`Wrote ${entries.length} logos to ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
