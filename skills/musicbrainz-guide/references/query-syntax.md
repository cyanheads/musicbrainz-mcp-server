# MusicBrainz query syntax

Use these expressions with `musicbrainz_search_entities`. Choose the entity index first; fields differ by index.

- Quote phrases: `recording:"Bohemian Rhapsody"`.
- Write Boolean operators in uppercase and group alternatives: `artist:(Radiohead OR "Thom Yorke") AND recording:"Creep"`.
- Escape literal query punctuation with a backslash. Inside JSON, encode that backslash as `\\`; for example, a literal `+` becomes `\\+` in the JSON string.
- Start with a quoted title and credited artist; refine with a resolved artist MBID when names collide.

| Index | Example expression |
|:---|:---|
| Artist | `artist:"Björk" AND country:IS` |
| Release-group | `releasegroup:"OK Computer" AND primarytype:album` |
| Release | `release:"OK Computer" AND country:JP AND format:CD` |
| Recording | `recording:"Creep" AND arid:a74b1b7f-71a5-4011-9441-d0b5e4122711` |
| Work | `work:"Bohemian Rhapsody"` |
| Label | `label:"Warp" AND country:GB` |

`arid` is an artist MBID; `rgid` is a release-group MBID. Replace example IDs with the identity resolved for the task. Search `primarytype` and `secondarytype` are distinct fields; browse filters have their own schema and do not accept Lucene expressions. Recording `firstreleasedate` concerns earliest release, not recording-session time.

Search exposes at most the first 500 matches. Narrow broad queries; use browse for complete linked sets. `totalCount` can exceed the accessible search window.

Sources: [MusicBrainz indexed search and fields](https://musicbrainz.org/doc/Indexed_Search_Syntax), [search window](https://musicbrainz.org/doc/Search), and [Lucene Boolean grouping and escaping](https://lucene.apache.org/core/3_6_2/queryparsersyntax.html).
