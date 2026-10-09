import { Card, CardContent, CardHeader, CardTitle, type CardPadding } from "../structure/card";
import type { GalleryGroup } from "./entry";

const cardPaddings: readonly CardPadding[] = ["md", "lg"];

export const structureGallery: GalleryGroup = {
  id: "structure",
  entries: [
    {
      name: "Card",
      components: ["Card", "CardHeader", "CardTitle", "CardContent"],
      render: (text) => (
        <div className="grid gap-4 sm:grid-cols-2">
          {cardPaddings.map((padding) => (
            <Card key={padding} padding={padding}>
              <CardHeader>
                <CardTitle>{text.cardTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-body text-muted-foreground">{text.cardBody}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )
    }
  ]
};
