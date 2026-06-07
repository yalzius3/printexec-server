import { SetMetadata } from "@nestjs/common";
import { PUBLIC_KEY } from "./supabase.guard";

export const Public = () => SetMetadata(PUBLIC_KEY, true);
