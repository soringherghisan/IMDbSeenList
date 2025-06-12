// This object will hold all our GraphQL query and mutation strings
const GQL_QUERIES = {
    getListItems: `
            query GetListItems($listId: ID!, $afterCursor: ID) { # Changed String to ID for $afterCursor
                list(id: $listId) {
                    items(first: 250, after: $afterCursor) {
                        edges {
                            node {
                                itemId          
                                listItem {
                                    __typename
                                    ... on Title {
                                        id   # This is the tconst (e.g., tt1234567)
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            }
        `,
    // This is the query used in removeFromList to find the item
    getListItemsForRemoval: `
            query GetListItemsForRemoval($listId: ID!, $afterCursor: ID) { # Changed String to ID for $afterCursor
                list(id: $listId) {
                    items(first: 250, after: $afterCursor) { # Fetch a batch of items
                        edges {
                            node {
                                itemId      # This is the ID we need for removal
                                listItem {
                                    __typename
                                    ... on Title {
                                        id  # This is the tconst (e.g., tt1234567)
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                    }
                }
            }
        `,
    addToList: `
            mutation AddToList($input: AddItemToListInput!) {
                addItemToList(input: $input) { # addItemToList returns ModifiedListOutput
                    listId # CHANGED: Ask for listId directly
                           # REMOVED: listItems, as it might not be on ModifiedListOutput
                }
            }
        `,

    removeFromList: `
            mutation RemoveFromList($input: RemoveItemsByItemIdsInput!) {
                removeItemsByItemIds(input: $input) {
                    itemIds # Array of itemIds that were successfully removed
                }
            }
        `
    // Add other queries/mutations here as needed
};