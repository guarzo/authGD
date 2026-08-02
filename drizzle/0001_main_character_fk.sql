-- Custom SQL migration file, put your code below! --
ALTER TABLE "account"
  ADD CONSTRAINT "account_main_character_fk"
  FOREIGN KEY ("main_character_id", "id")
  REFERENCES "character" ("id", "account_id")
  DEFERRABLE INITIALLY DEFERRED;
