import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../data/table";
import { Badge } from "../status/badge";
import type { GalleryGroup } from "./entry";

export const dataGallery: GalleryGroup = {
  id: "data",
  entries: [
    {
      name: "Table",
      components: ["Table", "TableHeader", "TableBody", "TableRow", "TableHead", "TableCell"],
      render: (text) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{text.tableName}</TableHead>
              <TableHead>{text.tableState}</TableHead>
              <TableHead>{text.tableUpdated}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>{text.rowAgent}</TableCell>
              <TableCell>
                <Badge tone="success">{text.statePublished}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.today}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{text.rowWorkflow}</TableCell>
              <TableCell>
                <Badge tone="info">{text.stateRunning}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.today}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{text.rowKnowledge}</TableCell>
              <TableCell>
                <Badge>{text.stateDraft}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.yesterday}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )
    }
  ]
};
