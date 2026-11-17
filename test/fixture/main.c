#include <stdio.h>
#include <string.h>

#include "kvstore.h"
#include "hash.h"

static int print_entry(const char *key, const char *val, void *arg)
{
    int *n = (int *)arg;

    printf("  [%d] %s = %s\n", *n, key, val);
    (*n)++;

    return 0;
}

int main(void)
{
    struct kv_store store;
    int printed = 0;
    const char *v;

    if (kv_init(&store, 1000) != KV_OK) {
        fprintf(stderr, "init failed\n");
        return 1;
    }

    kv_put(&store, "host", "10.0.0.1");
    kv_put(&store, "port", "8080");
    kv_put(&store, "proto", "tcp");

    v = kv_get(&store, "host");
    printf("host = %s\n", v ? v : "(nil)");

    kv_del(&store, "proto");

    printf("count = %lu\n", (unsigned long)kv_count(&store));
    printf("dump:\n");
    kv_foreach(&store, print_entry, &printed);

    printf("fnv1a(\"host\") = %lu\n", fnv1a("host", 4));

    kv_free(&store);

    return 0;
}
