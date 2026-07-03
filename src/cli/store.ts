import { isSafeNpmPackage, installGlobalNpmPackage } from '../util/npm.js';

const BEECORK_PREFIXES = [
  'beecork-capability-',
  'beecork-media-',
  'beecork-channel-',
  'beecork-watcher-',
];

export async function storeSearch(query: string): Promise<void> {
  console.log(`\nSearching for "${query}"...\n`);

  try {
    // Search npm registry for beecork-pipe packages
    const response = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=beecork+${encodeURIComponent(query)}&size=20`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (!response.ok) {
      console.log('Failed to search npm registry. Try: npm search beecork');
      return;
    }

    const data = (await response.json()) as {
      objects: Array<{ package: { name: string; description: string; version: string } }>;
    };
    const packages = data.objects.filter((o) =>
      BEECORK_PREFIXES.some((p) => o.package.name.startsWith(p)),
    );

    if (packages.length === 0) {
      console.log(`No beecork-pipe packages found for "${query}".`);
      console.log(
        'Community packages use naming convention: beecork-capability-*, beecork-media-*, beecork-channel-*',
      );
      return;
    }

    console.log(`${packages.length} package(s) found:\n`);
    for (const pkg of packages) {
      const p = pkg.package;
      const type =
        BEECORK_PREFIXES.find((prefix) => p.name.startsWith(prefix))
          ?.replace('beecork-', '')
          .replace('-', '') || '';
      console.log(`  ${p.name}@${p.version}`);
      console.log(`    ${p.description || 'No description'}`);
      console.log(`    Type: ${type}`);
      console.log('');
    }

    console.log('Install: beecork-pipe store install <package-name>\n');
  } catch (err) {
    console.error('Search failed:', err);
    console.log('Try manually: npm search beecork');
  }
}

export function storeInstall(packageName: string): void {
  // Normalize: if user types "shopify", try "beecork-capability-shopify" first
  let fullName = packageName;
  if (
    !BEECORK_PREFIXES.some((p) => packageName.startsWith(p)) &&
    !packageName.startsWith('beecork-')
  ) {
    // Try capability first, then media, then channel
    fullName = `beecork-capability-${packageName}`;
  }

  if (!isSafeNpmPackage(fullName)) {
    console.error(`Invalid package name: ${fullName}`);
    return;
  }
  console.log(`\nInstalling ${fullName}...\n`);
  try {
    installGlobalNpmPackage(fullName);
    console.log(`\n${fullName} installed.`);
    console.log('Restart daemon to activate: beecork-pipe stop && beecork-pipe start\n');
  } catch {
    // If beecork-capability- failed, try other prefixes
    if (fullName.startsWith('beecork-capability-')) {
      const baseName = packageName;
      for (const prefix of ['beecork-media-', 'beecork-channel-', 'beecork-']) {
        const altName = prefix + baseName;
        if (!isSafeNpmPackage(altName)) continue;
        try {
          installGlobalNpmPackage(altName);
          console.log(`\n${altName} installed.`);
          console.log('Restart daemon to activate: beecork-pipe stop && beecork-pipe start\n');
          return;
        } catch {
          continue;
        }
      }
    }
    console.error(`\nFailed to install ${fullName}. Check the package name.`);
    console.log('Search available packages: beecork-pipe store search <query>\n');
  }
}

export async function storeInfo(packageName: string): Promise<void> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log(`Package "${packageName}" not found on npm.`);
      return;
    }

    interface NpmRegistryPackage {
      name: string;
      description?: string;
      'dist-tags'?: { latest?: string };
      versions?: Record<
        string,
        {
          homepage?: string;
          repository?: { url?: string };
          license?: string;
        }
      >;
    }
    const data = (await response.json()) as NpmRegistryPackage;
    const latest = data['dist-tags']?.latest ?? '';
    const info = latest ? data.versions?.[latest] : undefined;

    console.log(`\n${data.name}@${latest}`);
    console.log(`  ${data.description || 'No description'}`);
    if (info?.homepage) console.log(`  Homepage: ${info.homepage}`);
    if (info?.repository?.url) console.log(`  Repository: ${info.repository.url}`);
    console.log(`  License: ${info?.license || 'Unknown'}`);
    console.log(`\n  Install: beecork-pipe store install ${data.name}\n`);
  } catch (err) {
    console.error('Failed to fetch package info:', err);
  }
}
