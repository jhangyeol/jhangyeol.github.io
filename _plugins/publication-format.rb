require 'cgi'
require 'nokogiri'

module Jekyll
  module PublicationFormat
    CATEGORIES = %w[Conferences Journals Workshops Preprints].freeze
    CONFERENCE_NAMES = {
      'NeurIPS' => /\b(?:NeurIPS|NIPS|(?:Advances in )?Neural Information Processing Systems)\b/i,
      'ICML' => /\b(?:ICML|International Conference on Machine Learning)\b/i,
      'ICLR' => /\b(?:ICLR|International Conference on Learning Representations)\b/i,
      'CVPR' => /\b(?:CVPR|(?:IEEE\/CVF )?Conference on Computer Vision and Pattern Recognition)\b/i,
      'ICCV' => /\b(?:ICCV|International Conference on Computer Vision)\b/i,
      'ECCV' => /\b(?:ECCV|European Conference on Computer Vision)\b/i,
      'VLSI Design' => /\b(?:VLSI Design|International Conference on VLSI Design)\b/i,
      'AAAI' => /\bAAAI\b/i,
      'IJCAI' => /\bIJCAI\b/i,
      'ACL' => /\bACL\b/i,
      'EMNLP' => /\bEMNLP\b/i,
      'NAACL' => /\bNAACL\b/i,
      'AISTATS' => /\bAISTATS\b/i,
      'UAI' => /\bUAI\b/i,
      'KDD' => /\bKDD\b/i
    }.freeze

    # An optional category field can override inference for ambiguous venues.
    def publication_category(entry)
      override = CATEGORIES.find { |category| category.casecmp(entry['category'].to_s).zero? }
      return override if override

      venue = [entry['booktitle'], entry['journal'], entry['abbr']].join(' ')
      return 'Preprints' if venue.match?(/\b(?:under review|submitted|preprint)\b/i)
      return 'Workshops' if venue.match?(/\bworkshops?\b/i)
      return 'Conferences' if CONFERENCE_NAMES.values.any? { |pattern| venue.match?(pattern) }
      return 'Conferences' if venue.match?(/\b(?:conference|symposium|proceedings)\b/i)
      return 'Conferences' if %w[inproceedings conference].include?(entry['type'].to_s)
      return 'Preprints' if venue.match?(/\b(?:arxiv|biorxiv|medrxiv|techrxiv)\b/i)
      return 'Journals' unless entry['journal'].to_s.strip.empty?

      'Preprints'
    end

    def publication_venue(venue)
      venue.to_s.gsub(/\b(?:19|20)\d{2}\b/, '').gsub(/\s+/, ' ').strip
    end

    def conference_venue(venue)
      text = publication_venue(venue)
      match = CONFERENCE_NAMES.find { |_name, pattern| text.match?(pattern) }
      return CGI.escapeHTML(text) unless match

      name, pattern = match
      # Keep status text uncolored and normalize recognized full names to acronyms.
      parts = text.split(pattern, 2)
      "#{CGI.escapeHTML(parts[0])}<span class=\"conference-name\">#{name}</span>#{CGI.escapeHTML(parts[1].to_s)}"
    end

    def group_publications(html)
      fragment = Nokogiri::HTML.fragment(html)
      entries = fragment.css('ol.bibliography > li').group_by do |item|
        item.at_css('[data-publication-category]')&.[]('data-publication-category') || 'Preprints'
      end
      CATEGORIES.map do |category|
        items = entries[category]
        next if items.nil? || items.empty?

        "<h2 class=\"bibliography publication-category\">#{category}</h2>" \
          "<ol class=\"bibliography\">#{items.map(&:to_html).join}</ol>"
      end.compact.join("\n")
    end
  end
end

Liquid::Template.register_filter(Jekyll::PublicationFormat)
