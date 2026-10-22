```mermaid
classDiagram
    direction TB

    class GalleryBlueprint {
        +url_prefix : str
        +get_maps() Response
        +get_map(id) Response
        +get_comments(map_id) Response
        +post_comment(map_id) Response
        +put_comment(id) Response
        +delete_comment(id) Response
        +get_stream(map_id) Response
    }
```
