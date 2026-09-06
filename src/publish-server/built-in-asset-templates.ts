import { BUILT_IN_ASSET_TEMPLATES, OPEN_GAME_TEMPLATE_AUTHOR } from "../shared/built-in-asset-templates.js";
import type { PublishStore, StoredTemplate, StoredTemplateRelease } from "./store.js";

export function seedBuiltInAssetTemplates(store: PublishStore): void {
  for (const entry of BUILT_IN_ASSET_TEMPLATES) {
    const template: StoredTemplate = {
      id: entry.id,
      publisherId: OPEN_GAME_TEMPLATE_AUTHOR.id,
      name: entry.name,
      currentReleaseId: entry.releaseId,
      createdAt: entry.publishedAt,
      updatedAt: entry.publishedAt,
    };
    const { id: _id, releaseId: _releaseId, publishedAt: _publishedAt, ...definition } = entry;
    const release: StoredTemplateRelease = {
      id: entry.releaseId,
      templateId: entry.id,
      definition,
      hasCover: false,
      publishedAt: entry.publishedAt,
    };
    store.seedTemplate(template, release, OPEN_GAME_TEMPLATE_AUTHOR);
  }
}
