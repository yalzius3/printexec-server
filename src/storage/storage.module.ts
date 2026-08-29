import { Global, Module } from "@nestjs/common";
import { StorageFilesService } from "./storage-files.service";

// Global, for the same reason DatabaseModule is: object deletion is now a
// cross-cutting concern. Orders, order-pieces, order-attachments, beds,
// maintenance and licensing all have a delete path that has to remove bytes,
// and threading an import edge from six modules to one leaf service buys
// nothing but churn — there is exactly one implementation and nobody may have
// a second.
@Global()
@Module({
  providers: [StorageFilesService],
  exports: [StorageFilesService]
})
export class StorageModule {}
