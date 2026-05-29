variable "users" {
  type    = list(string)
  default = ["alice", "bob", "charlie"]
}

resource "aws_iam_user" "team" {
  count = length(var.users)
  name  = var.users[count.index]
}

resource "aws_s3_bucket" "user_data" {
  count  = length(var.users)
  bucket = "data-${var.users[count.index]}"
}
