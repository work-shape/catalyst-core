import { actionsGallery } from "./actions";
import { dataGallery } from "./data";
import type { GalleryGroup } from "./entry";
import { feedbackGallery } from "./feedback";
import { formsGallery } from "./forms";
import { foundationsGallery } from "./foundations";
import { navigationGallery } from "./navigation";
import { overlaysGallery } from "./overlays";
import { statusGallery } from "./status";
import { structureGallery } from "./structure";

/** Every gallery group in the order the gallery shows them. Each group file is owned by one ticket. */
export const galleryGroups: readonly GalleryGroup[] = [
  foundationsGallery,
  actionsGallery,
  formsGallery,
  overlaysGallery,
  navigationGallery,
  structureGallery,
  dataGallery,
  statusGallery,
  feedbackGallery
];
