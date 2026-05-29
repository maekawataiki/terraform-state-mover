resource "aws_route53_zone" "main" {
  name = "example.com"
}

resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.example.com"
  type    = "A"
  alias {
    name                   = "alb.example.com"
    zone_id                = aws_route53_zone.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "cdn" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "cdn.example.com"
  type    = "CNAME"
  ttl     = 300
  records = [aws_cloudfront_distribution.main.domain_name]
}
