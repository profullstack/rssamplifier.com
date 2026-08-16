-- Machine translation of a post's title and summary.
--
-- The directory indexes the whole small web, and a lot of it is not in English:
-- a Proxmox forum thread about UEFI settings is just as useful to an English
-- reader as an English one, right up until the moment they cannot read it.
--
-- Translations are cached per (post, language) rather than per reader, because
-- the translation of a post does not depend on who asked for it. The first
-- reader to want a German post in English pays the API call; everybody after
-- them reads it out of this table. That is also what makes the feature
-- affordable at 47k feeds — cost scales with distinct posts read, not views.
--
-- `lang` is a bare ISO-639-1 code ('de', not 'de-DE'). The application
-- normalises before it ever gets here, so the primary key cannot be split
-- across two spellings of the same language.

create table if not exists item_translations (
  item_id     text not null references feed_items (id) on delete cascade,
  lang        text not null,

  title       text not null,
  summary     text,

  -- Which model produced this. Kept so a future model change can be rolled out
  -- by deleting rows rather than by guessing which ones are stale.
  model       text not null,
  source_lang text,

  created_at  text not null,

  primary key (item_id, lang)
);

-- The reader's own language, so choosing it once carries to the next post.
-- Null means "no preference", which is not the same as English: it is what
-- makes the language bar render with nothing selected for a new account.
alter table users add column reading_language text;

-- The language bar is built from the languages the directory actually holds,
-- which means grouping 47k feeds by language on a cold cache.
create index if not exists feeds_language_idx on feeds (language) where language is not null;
