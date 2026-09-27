-- The 20 site rooms. Generic names of our own; edit freely (the pool is capped at 20).
-- min_trust_to_post: 0 = new accounts may post (Newcomers, Help Desk); 1 = confirmed email.
INSERT INTO rooms (slug, name, category, sort_order, min_trust_to_post, description)
SELECT v.* FROM (VALUES
  ('newcomers',          'Newcomers',          'Start here',          10, 0::smallint, 'Say hi while you confirm your email.'),
  ('lobby',              'The Lobby',          'Start here',          20, 1, 'General chat, out of character.'),
  ('help-desk',          'Help Desk',          'Start here',          30, 0, 'Questions about the site and its rules.'),
  ('ooc-lounge',         'OOC Lounge',         'Out of character',    40, 1, 'Talk about anything outside your stories.'),
  ('character-creation', 'Character Creation', 'Out of character',    50, 1, 'Build and share characters.'),
  ('story-workshop',     'Story Workshop',     'Out of character',    60, 1, 'Plan plots and find partners.'),
  ('tavern',             'The Tavern',         'Fantasy',             70, 1, 'Swords, sorcery and a warm hearth.'),
  ('kingdoms',           'Kingdoms',           'Fantasy',             80, 1, 'Courts, crowns and intrigue.'),
  ('pirate-cove',        'Pirate Cove',        'Fantasy',             90, 1, 'High seas and hidden treasure.'),
  ('starport',           'Starport',           'Sci-fi',             100, 1, 'Ships, stations and the far frontier.'),
  ('cyber-alley',        'Cyber Alley',        'Sci-fi',             110, 1, 'Neon streets and tech noir.'),
  ('wasteland',          'The Wasteland',      'Sci-fi',             120, 1, 'Survival after the fall.'),
  ('noir-city',          'Noir City',          'Genre',              130, 1, 'Detectives, rain and bad decisions.'),
  ('haunted-manor',      'Haunted Manor',      'Genre',              140, 1, 'Horror and the unexplained.'),
  ('wild-west',          'Wild West',          'Genre',              150, 1, 'Dusty towns and outlaws.'),
  ('hero-league',        'Hero League',        'Genre',              160, 1, 'Original heroes and villains.'),
  ('academy',            'The Academy',        'Genre',              170, 1, 'Campus life and slice of life.'),
  ('late-night',         'Late Night',         'Hangouts',           180, 1, 'For the night owls.'),
  ('music',              'Music',              'Hangouts',           190, 1, 'What are you listening to?'),
  ('gaming',             'Gaming',             'Hangouts',           200, 1, 'Games of every kind.')
) AS v(slug, name, category, sort_order, min_trust_to_post, description)
WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.slug = v.slug); -- safe to re-run
