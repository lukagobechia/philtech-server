import { z } from "zod";

export const paginationQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function toSkipTake({ page, limit }: Pagination): { skip: number; take: number } {
    return { skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: Pagination) {
    return { items, total, page, limit };
}
